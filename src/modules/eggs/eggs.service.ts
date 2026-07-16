import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { EGG_CATALOG } from './egg-catalog';
import {
  resolveServer as resolveEggServer,
  normalizeValues,
  interpolate,
  valueForKey,
  dockerImageOptions,
  resolveDockerImage,
} from './egg-resolver';
import {
  EggDefinition,
  EggDockerImage,
  EggInstallScript,
  EggNest,
  EggVariable,
  ResolvedEggServer,
} from './eggs.types';

export type { EggCatalogItem, EggDefinition, EggDockerImage, EggInstallScript, EggNest, EggVariable, ResolvedEggServer } from './eggs.types';
export { EGG_CATALOG } from './egg-catalog';

@Injectable()
export class EggsService implements OnModuleInit {
  private static readonly DEFAULT_NEST_ID = 'uncategorized';
  private readonly logger = new Logger(EggsService.name);
  private readonly eggs = new Map<string, EggDefinition>();
  private readonly nests = new Map<string, EggNest>();
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'eggs.json');
  private readonly nestsFile = path.join(__dirname, '..', '..', 'data', 'egg-nests.json');

  constructor(private readonly database: DatabaseService) {
    this.loadNests();
    this.ensureDefaultNest();
    this.load();
  }

  async onModuleInit() {
    if (!this.database.enabled) return;
    const nests = await this.database.hydrateCollection('egg-nests', Array.from(this.nests.values()), nest => nest.id);
    this.nests.clear();
    for (const nest of nests) this.nests.set(nest.id, nest);
    this.ensureDefaultNest();
    const records = await this.database.hydrateCollection('eggs', Array.from(this.eggs.values()), egg => egg.id);
    this.eggs.clear();
    for (const egg of records) {
      const hydrated = this.hydrateLoadedEgg(egg);
      this.eggs.set(hydrated.id, hydrated);
    }
  }

  list() {
    return Array.from(this.eggs.keys()).map(id => this.publicEgg(this.get(id)));
  }

  clientList(role: string) {
    return Array.from(this.eggs.keys()).map(id => this.clientEgg(id, role));
  }

  clientEgg(id: string, role: string, includeVariables = true) {
    const egg = this.publicEgg(this.get(id));
    const privileged = role === 'owner' || role === 'admin';
    return {
      id: egg.id,
      nestId: egg.nestId,
      nestName: egg.nestName,
      name: egg.name,
      description: egg.description,
      images: egg.images,
      dockerImages: egg.dockerImages,
      startup: egg.startup,
      variables: includeVariables
        ? (privileged ? egg.variables : egg.variables.filter(variable => variable.userEditable))
        : [],
      install: privileged ? egg.install : undefined
    };
  }

  listNests() {
    return Array.from(this.nests.values())
      .map(nest => ({
        id: nest.id,
        name: nest.name,
        description: nest.description,
        eggCount: Array.from(this.eggs.values()).filter(egg => egg.nestId === nest.id).length
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  createNest(input: any) {
    const name = String(input?.name || '').trim();
    if (!name) throw new Error('nest name is required');
    const id = this.slug(input?.id || name);
    if (!id) throw new Error('nest id is required');
    if (this.nests.has(id)) throw new Error('nest already exists');
    const nest: EggNest = {
      id,
      name,
      description: String(input?.description || '').trim() || undefined,
      createdAt: new Date().toISOString()
    };
    this.nests.set(id, nest);
    this.saveNests();
    return nest;
  }

  updateNest(id: string, input: any) {
    const current = this.nests.get(id);
    if (!current) throw new Error('nest not found');
    const next = {
      ...current,
      name: String(input?.name ?? current.name).trim() || current.name,
      description: input?.description === undefined ? current.description : String(input.description || '').trim() || undefined
    };
    this.nests.set(id, next);
    this.saveNests();
    return next;
  }

  removeNest(id: string) {
    if (id === EggsService.DEFAULT_NEST_ID) throw new Error('the default nest cannot be removed');
    if (!this.nests.delete(id)) throw new Error('nest not found');
    for (const egg of this.eggs.values()) {
      if (egg.nestId === id) egg.nestId = EggsService.DEFAULT_NEST_ID;
    }
    this.saveNests();
    this.save();
    return { id, deleted: true };
  }

  assignNest(eggId: string, nestId: string) {
    const egg = this.get(eggId);
    if (!this.nests.has(nestId)) throw new Error('nest not found');
    egg.nestId = nestId;
    this.eggs.set(egg.id, egg);
    this.save();
    return this.publicEgg(egg);
  }

  catalog() {
    return EGG_CATALOG.map(item => ({
      ...item,
      installed: this.eggs.has(item.eggId)
    }));
  }

  async installCatalog(id: string) {
    const item = EGG_CATALOG.find(candidate => candidate.id === id);
    if (!item) throw new Error(`catalog egg '${id}' not found`);
    if (this.eggs.has(item.eggId)) return this.publicEgg(this.get(item.eggId));
    if (!item.sourceUrl) throw new Error(`catalog egg '${id}' is bundled but not installed`);
    const nest = this.ensureNestByName(item.category);
    const installed = this.normalize(await this.downloadCatalogEgg(item.sourceUrl));
    installed.nestId = nest.id;
    this.eggs.set(installed.id, installed);
    this.save();
    return this.publicEgg(installed);
  }

  get(id: string) {
    const egg = this.eggs.get(id);
    if (!egg) throw new Error(`egg '${id}' not found`);

    if (!this.needsHydration(egg)) {
      return egg;
    }

    const hydrated = this.hydrateLoadedEgg(egg);
    this.eggs.set(hydrated.id, hydrated);
    this.save();
    return hydrated;
  }

  validateIds(ids: unknown, requiredId?: string) {
    const values = Array.isArray(ids) ? ids : String(ids || '').split(',');
    const normalized = Array.from(new Set([
      ...(requiredId ? [requiredId] : []),
      ...values.map(String).map(value => value.trim()).filter(Boolean)
    ]));
    for (const id of normalized) this.get(id);
    return normalized;
  }

  userEditableVariableKeys(id?: string) {
    if (!id) return new Set<string>();
    return new Set(
      this.get(id).variables
        .filter(variable => variable.userEditable)
        .map(variable => variable.envVariable.toUpperCase())
    );
  }

  import(raw: any) {
    const egg = this.normalize(raw);
    this.eggs.set(egg.id, egg);
    this.save();
    return this.publicEgg(egg);
  }

  importMany(rawEggs: unknown) {
    if (!Array.isArray(rawEggs) || rawEggs.length === 0) {
      throw new Error('egg batch must contain at least one egg');
    }
    if (rawEggs.length > 100) {
      throw new Error('egg batch cannot contain more than 100 eggs');
    }

    const normalized = rawEggs.map(raw => this.normalize(raw));
    const ids = new Set<string>();
    for (const egg of normalized) {
      if (ids.has(egg.id)) throw new Error(`egg batch contains duplicate id '${egg.id}'`);
      ids.add(egg.id);
    }

    for (const egg of normalized) this.eggs.set(egg.id, egg);
    this.save();
    return normalized.map(egg => this.publicEgg(egg));
  }

  remove(id: string) {
    if (!this.eggs.delete(id)) throw new Error(`egg '${id}' not found`);
    this.save();
    return { id, deleted: true };
  }

  resolveServer(eggId: string, body: any): ResolvedEggServer {
    const egg = this.get(eggId);
    return resolveEggServer(egg, body);
  }

  private normalize(raw: any): EggDefinition {
    const name = raw?.name || raw?.meta?.name;
    if (!name) throw new Error('egg name is required');

    const id = this.slug(raw?.id || raw?.meta?.name || name);
    const dockerImages = this.normalizeDockerImages(raw);
    const images = dockerImages.map(item => item.image);
    if (!images.length) throw new Error('egg must define at least one docker image');

    return {
      id,
      nestId: this.resolveNestId(raw),
      name,
      description: raw?.description || raw?.meta?.description,
      images,
      dockerImages,
      startup: String(raw?.startup || ''),
      stopCommand: String(raw?.config?.stop || ''),
      startupDone: String(this.normalizeConfigObject(raw?.config?.startup)?.done || ''),
      environment: normalizeValues(raw?.environment || {}),
      variables: this.normalizeVariables(raw?.variables || []),
      install: this.normalizeInstall(raw?.scripts?.installation),
      configFiles: this.normalizeConfigFiles(raw?.config?.files),
      raw
    };
  }

  private normalizeDockerImages(raw: any): EggDockerImage[] {
    if (Array.isArray(raw?.dockerImages)) {
      return raw.dockerImages.map((item: any) => ({
        label: String(item?.label || item?.name || item?.image || item),
        image: String(item?.image || item?.value || item)
      })).filter((item: EggDockerImage) => item.image);
    }

    if (Array.isArray(raw?.images)) {
      return raw.images.map((image: any, index: number) => ({
        label: String(raw?.imageLabels?.[index] || image),
        image: String(image)
      })).filter((item: EggDockerImage) => item.image);
    }

    if (raw?.docker_images && typeof raw.docker_images === 'object') {
      return Object.entries(raw.docker_images).map(([label, image]) => ({
        label: String(label),
        image: String(image)
      })).filter(item => item.image);
    }

    return [];
  }

  private normalizeVariables(variables: any[]): EggVariable[] {
    return variables.map(variable => ({
      name: String(variable.name || variable.env_variable || variable.envVariable || ''),
      envVariable: String(variable.env_variable || variable.envVariable || variable.name || '').toUpperCase(),
      defaultValue: String(variable.default_value ?? variable.defaultValue ?? ''),
      required: String(variable.rules || '').includes('required'),
      userEditable: Boolean(variable.user_editable ?? variable.userEditable ?? true),
      description: variable.description
    })).filter(variable => variable.envVariable);
  }

  private normalizeInstall(install: any): EggInstallScript | undefined {
    if (!install?.script || !install?.container) return undefined;
    return {
      container: String(install.container),
      entrypoint: String(install.entrypoint || ''),
      script: String(install.script)
    };
  }

  private normalizeConfigFiles(value: any): Record<string, any> {
    if (!value) return {};
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  private normalizeConfigObject(value: any): Record<string, any> {
    if (!value) return {};
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  private publicEgg(egg: EggDefinition) {
    const nest = this.nests.get(egg.nestId) || this.nests.get(EggsService.DEFAULT_NEST_ID);
    return {
      id: egg.id,
      nestId: nest?.id || EggsService.DEFAULT_NEST_ID,
      nestName: nest?.name || 'Uncategorized',
      name: egg.name,
      description: egg.description,
      images: egg.images,
      dockerImages: dockerImageOptions(egg),
      startup: egg.startup,
      stopCommand: egg.stopCommand,
      startupDone: egg.startupDone,
      environment: egg.environment,
      variables: egg.variables,
      install: egg.install ? {
        container: egg.install.container,
        entrypoint: egg.install.entrypoint,
        hasScript: Boolean(egg.install.script)
      } : undefined,
      configFiles: egg.configFiles || {}
    };
  }

  private slug(value: string) {
    return String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private downloadCatalogEgg(url: string, redirects = 0): Promise<any> {
    if (redirects > 3) return Promise.reject(new Error('catalog egg download redirected too many times'));
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'raw.githubusercontent.com') {
      return Promise.reject(new Error('catalog egg source is not trusted'));
    }

    return new Promise((resolve, reject) => {
      const request = https.get(parsed, {
        headers: { 'User-Agent': 'Agapornis-Egg-Catalog/1.0', Accept: 'application/json' }
      }, response => {
        const status = response.statusCode || 0;
        if ([301, 302, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          this.downloadCatalogEgg(new URL(response.headers.location, parsed).toString(), redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`catalog egg download failed with HTTP ${status}`));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            request.destroy(new Error('catalog egg exceeds 2 MB'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('catalog egg did not contain valid JSON'));
          }
        });
      });
      request.setTimeout(15_000, () => request.destroy(new Error('catalog egg download timed out')));
      request.on('error', reject);
    });
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) return;
    const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as EggDefinition[];
    let migrated = false;
    for (const egg of parsed) {
      const hydrated = this.hydrateLoadedEgg(egg);
      migrated ||= hydrated !== egg;
      this.eggs.set(hydrated.id, hydrated);
    }

    if (migrated) this.save();
  }

  private save() {
    if (this.database.enabled) {
      void this.database.replaceCollection('eggs', Array.from(this.eggs.values()), egg => egg.id)
        .catch(error => this.logger.error(`Failed to persist eggs: ${error?.message || error}`));
      return;
    }
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(Array.from(this.eggs.values()), null, 2));
  }

  private loadNests() {
    if (!fs.existsSync(this.nestsFile)) return;
    try {
      const records = JSON.parse(fs.readFileSync(this.nestsFile, 'utf8')) as EggNest[];
      for (const nest of records) this.nests.set(nest.id, nest);
    } catch {
      // A corrupt optional nest catalog must not prevent egg recovery.
    }
  }

  private saveNests() {
    const values = Array.from(this.nests.values());
    if (this.database.enabled) {
      void this.database.replaceCollection('egg-nests', values, nest => nest.id)
        .catch(error => this.logger.error(`Failed to persist egg nests: ${error?.message || error}`));
      return;
    }
    fs.mkdirSync(path.dirname(this.nestsFile), { recursive: true });
    fs.writeFileSync(this.nestsFile, JSON.stringify(values, null, 2));
  }

  private ensureDefaultNest() {
    if (this.nests.has(EggsService.DEFAULT_NEST_ID)) return;
    this.nests.set(EggsService.DEFAULT_NEST_ID, {
      id: EggsService.DEFAULT_NEST_ID,
      name: 'Uncategorized',
      description: 'Eggs that have not been assigned to a nest.',
      createdAt: new Date().toISOString()
    });
  }

  private ensureNestByName(name: string) {
    const id = this.slug(name) || EggsService.DEFAULT_NEST_ID;
    const existing = this.nests.get(id);
    if (existing) return existing;
    const nest: EggNest = { id, name, createdAt: new Date().toISOString() };
    this.nests.set(id, nest);
    this.saveNests();
    return nest;
  }

  private resolveNestId(raw: any) {
    const requested = String(raw?.nestId || raw?.nest_id || raw?.meta?.nest || '').trim();
    if (!requested) return EggsService.DEFAULT_NEST_ID;
    const id = this.slug(requested);
    return this.nests.has(id) ? id : this.ensureNestByName(requested).id;
  }

  private hydrateLoadedEgg(egg: EggDefinition): EggDefinition {
    if (egg.raw) {
      const normalized = this.normalize(egg.raw);
      return {
        ...normalized,
        id: egg.id || normalized.id,
        nestId: egg.nestId || normalized.nestId || EggsService.DEFAULT_NEST_ID
      };
    }

    const dockerImages = egg.dockerImages?.length
      ? egg.dockerImages
      : (egg.images || []).map(image => ({ label: image, image }));

    if (
      egg.dockerImages?.length &&
      egg.configFiles !== undefined &&
      egg.stopCommand !== undefined &&
      egg.startupDone !== undefined
    ) {
      return { ...egg, nestId: egg.nestId || EggsService.DEFAULT_NEST_ID };
    }

    return {
      ...egg,
      nestId: egg.nestId || EggsService.DEFAULT_NEST_ID,
      dockerImages,
      configFiles: egg.configFiles || {},
      stopCommand: egg.stopCommand || '',
      startupDone: egg.startupDone || ''
    };
  }

  private needsHydration(egg: EggDefinition) {
    if (!egg.dockerImages?.length) return true;
    if (egg.configFiles === undefined) return true;
    if (egg.stopCommand === undefined || egg.startupDone === undefined) return true;
    if (egg.raw?.scripts?.installation && !egg.install?.script) return true;
    if (egg.raw?.config?.files && Object.keys(egg.configFiles || {}).length === 0) return true;
    return false;
  }
}
