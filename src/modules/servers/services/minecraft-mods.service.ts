import { Injectable } from '@nestjs/common';
import * as https from 'https';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { GameVersionCatalogService } from './game-version-catalog.service';
import type { ServerRecord } from './server-registry.service';
import { PanelSettingsService } from '../../settings/panel-settings.service';

export type ModProvider = 'modrinth' | 'curseforge';
export type ModProjectType = 'mod' | 'modpack';

export interface ModSearchQuery {
  query?: string;
  provider?: ModProvider | 'all';
  projectType: ModProjectType;
  gameVersion?: string;
  loader?: string;
  page: number;
  pageSize: number;
}

type InstallSelection = {
  provider: ModProvider;
  projectId: string;
  projectType: ModProjectType;
  versionId?: string;
  gameVersion?: string;
  loader?: string;
};

type DownloadSelection = {
  provider: ModProvider;
  projectType: ModProjectType;
  projectId: string;
  versionId: string;
  title: string;
  fileName: string;
  url: string;
};

const MODRINTH_API = 'https://api.modrinth.com/v2';
const CURSEFORGE_API = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;
const MOD_CLASS_ID = 6;
const MODPACK_CLASS_ID = 4471;
const MAX_PROJECT_BYTES = 128 * 1024 * 1024;
const USER_AGENT = 'Agapornis-Minecraft-Mod-Browser/1.0 (https://github.com/Nullptr-exe/agapornis)';

const CURSEFORGE_LOADERS: Record<string, number> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};

@Injectable()
export class MinecraftModsService {
  constructor(
    private readonly client: AgentClientService,
    private readonly versions: GameVersionCatalogService,
    private readonly settings: PanelSettingsService,
  ) {}

  profile(server: ServerRecord) {
    const descriptor = this.versions.descriptor(server.eggId || '', server.variables || {});
    if (!descriptor || descriptor.gameId !== 'minecraft' || descriptor.kind === 'proxy' || /bedrock/i.test(`${descriptor.eggId} ${descriptor.name}`)) {
      throw new Error('mods are only available for Minecraft game servers');
    }
    return {
      minecraft: true,
      gameVersion: descriptor.currentVersion || this.variable(server, ['MINECRAFT_VERSION', 'VERSION', 'MC_VERSION']),
      loader: descriptor.kind === 'mod-loader' ? descriptor.provider : this.variable(server, ['MOD_LOADER', 'LOADER']),
      loaderCapable: descriptor.kind === 'mod-loader',
      provider: descriptor.provider,
    };
  }

  providers() {
    return [
      { id: 'modrinth', name: 'Modrinth', enabled: true },
      {
        id: 'curseforge',
        name: 'CurseForge',
        enabled: Boolean(this.curseForgeKey()),
        reason: this.curseForgeKey() ? undefined : 'Set CURSEFORGE_API_KEY to enable this provider.',
      },
    ];
  }

  async search(server: ServerRecord, query: ModSearchQuery) {
    const profile = this.profile(server);
    const requested = query.provider || 'all';
    const providers = requested === 'all'
      ? this.providers().filter(provider => provider.enabled).map(provider => provider.id as ModProvider)
      : [requested];
    if (!providers.length) return { items: [], page: query.page, pageSize: query.pageSize, total: 0, providers: this.providers(), profile };
    if (providers.includes('curseforge') && !this.curseForgeKey()) {
      throw new Error('CurseForge is not configured on this panel');
    }

    const perProviderSize = Math.max(1, Math.ceil(query.pageSize / providers.length));
    const providerQuery = {
      ...query,
      gameVersion: query.gameVersion || profile.gameVersion,
      loader: query.loader || profile.loader,
      pageSize: perProviderSize,
    };
    const pages = await Promise.all(providers.map(provider =>
      provider === 'modrinth'
        ? this.searchModrinth(providerQuery)
        : this.searchCurseForge(providerQuery)
    ));
    return {
      items: pages.flatMap(page => page.items).slice(0, query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: pages.reduce((sum, page) => sum + page.total, 0),
      providers: this.providers(),
      profile,
    };
  }

  async installed(server: ServerRecord) {
    this.profile(server);
    const response: any = await this.client.listDirectory(server.nodeId, server.id, '/mods');
    const items = response?.items || [];
    return {
      items: items
        .filter((item: any) => !(item.is_directory ?? item.isDirectory))
        .filter((item: any) => /\.jar(?:\.disabled)?$/i.test(String(item.name || '')))
        .map((item: any) => ({
          name: String(item.name),
          path: `/mods/${item.name}`,
          size: Number(item.size || 0),
          lastModified: item.last_modified || item.lastModified,
          enabled: !String(item.name).endsWith('.disabled'),
        }))
        .sort((left: any, right: any) => left.name.localeCompare(right.name)),
    };
  }

  async install(server: ServerRecord, selection: InstallSelection) {
    const profile = this.profile(server);
    if (selection.projectType === 'modpack' && server.status === 'running') {
      throw new Error('stop the Minecraft server before installing a modpack');
    }
    if (selection.projectType === 'modpack' && !profile.loaderCapable) {
      throw new Error('select a Forge, NeoForge, Fabric, or Quilt runtime before installing a modpack');
    }
    if (!profile.loaderCapable && selection.projectType === 'mod') {
      throw new Error('select a Forge, NeoForge, Fabric, or Quilt server runtime before installing mods');
    }
    const resolved = selection.provider === 'modrinth'
      ? await this.resolveModrinth(selection, profile)
      : await this.resolveCurseForge(selection, profile);
    const modpackExtension = resolved.fileName.toLowerCase().endsWith('.mrpack') ? '.mrpack' : '.zip';
    const targetPath = selection.projectType === 'mod'
      ? `/mods/${this.safeFileName(resolved.fileName, '.jar')}`
      : `/.agapornis/modpacks/${this.safeFileName(resolved.fileName, modpackExtension)}`;

    const upload: any = await this.client.uploadFile(
      server.nodeId,
      server.id,
      targetPath,
      this.download(resolved),
    );
    if (upload?.success === false) {
      throw new Error(upload.error_message || upload.errorMessage || 'agent rejected the project file');
    }

    if (selection.projectType === 'modpack') {
      const extracted: any = /\.mrpack$/i.test(resolved.fileName)
        ? await this.client.installModpack(server.nodeId, server.id, targetPath)
        : await this.client.extractArchive(server.nodeId, server.id, targetPath, '/');
      if (extracted?.success === false) {
        throw new Error(extracted.error_message || extracted.errorMessage || 'agent could not extract the server pack');
      }
      await this.client.deleteFileOrDirectory(server.nodeId, server.id, targetPath).catch(() => undefined);
    }

    return {
      success: true,
      provider: resolved.provider,
      projectId: resolved.projectId,
      versionId: resolved.versionId,
      title: resolved.title,
      fileName: resolved.fileName,
      targetPath: selection.projectType === 'modpack' ? '/' : targetPath,
    };
  }

  async remove(server: ServerRecord, targetPath: string) {
    this.profile(server);
    const normalized = String(targetPath || '').trim().replace(/\\/g, '/');
    const fileName = normalized.startsWith('/mods/') ? normalized.slice('/mods/'.length) : normalized;
    if (!fileName || fileName.includes('/') || fileName === '.' || fileName === '..' || !/\.jar(?:\.disabled)?$/i.test(fileName)) {
      throw new Error('only installed mod files can be removed here');
    }
    const installedPath = `/mods/${fileName}`;
    const response: any = await this.client.deleteFileOrDirectory(server.nodeId, server.id, installedPath);
    if (response?.success === false) throw new Error(response.error_message || response.errorMessage || 'agent could not remove the mod');
    return { success: true, path: installedPath };
  }

  private async searchModrinth(query: ModSearchQuery) {
    const facets: string[][] = [
      [`project_type:${query.projectType}`],
      ['server_side:required', 'server_side:optional'],
    ];
    if (query.gameVersion) facets.push([`versions:${query.gameVersion}`]);
    if (query.loader) facets.push([`categories:${query.loader.toLowerCase()}`]);
    const params = new URLSearchParams({
      query: query.query || '',
      facets: JSON.stringify(facets),
      limit: String(query.pageSize),
      offset: String((query.page - 1) * query.pageSize),
      index: 'downloads',
    });
    const data = await this.requestJson(`${MODRINTH_API}/search?${params}`);
    return {
      total: Number(data?.total_hits || 0),
      items: (data?.hits || []).map((item: any) => ({
        provider: 'modrinth',
        projectId: String(item.project_id),
        slug: item.slug,
        type: item.project_type,
        title: item.title,
        description: item.description,
        author: item.author,
        iconUrl: item.icon_url,
        downloads: Number(item.downloads || 0),
        updatedAt: item.date_modified,
        versions: item.versions || [],
        loaders: (item.categories || []).filter((category: string) => CURSEFORGE_LOADERS[category.toLowerCase()]),
      })),
    };
  }

  private async searchCurseForge(query: ModSearchQuery) {
    const params = new URLSearchParams({
      gameId: String(MINECRAFT_GAME_ID),
      classId: String(query.projectType === 'mod' ? MOD_CLASS_ID : MODPACK_CLASS_ID),
      searchFilter: query.query || '',
      index: String((query.page - 1) * query.pageSize),
      pageSize: String(Math.min(50, query.pageSize)),
      sortField: '6',
      sortOrder: 'desc',
    });
    if (query.gameVersion) params.set('gameVersion', query.gameVersion);
    const loader = CURSEFORGE_LOADERS[String(query.loader || '').toLowerCase()];
    if (loader && query.gameVersion) params.set('modLoaderType', String(loader));
    const data = await this.requestJson(`${CURSEFORGE_API}/mods/search?${params}`, this.curseForgeHeaders());
    return {
      total: Number(data?.pagination?.totalCount || 0),
      items: (data?.data || []).map((item: any) => ({
        provider: 'curseforge',
        projectId: String(item.id),
        slug: item.slug,
        type: query.projectType,
        title: item.name,
        description: item.summary,
        author: item.authors?.map((author: any) => author.name).join(', '),
        iconUrl: item.logo?.thumbnailUrl || item.logo?.url,
        downloads: Number(item.downloadCount || 0),
        updatedAt: item.dateModified,
        versions: Array.from(new Set((item.latestFilesIndexes || []).map((file: any) => file.gameVersion))),
        loaders: Array.from(new Set((item.latestFilesIndexes || []).map((file: any) => this.curseForgeLoaderName(file.modLoader)).filter(Boolean))),
      })),
    };
  }

  private async resolveModrinth(selection: InstallSelection, profile: any): Promise<DownloadSelection> {
    const params = new URLSearchParams();
    const gameVersion = selection.gameVersion || profile.gameVersion;
    const loader = selection.loader || profile.loader;
    if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
    if (loader) params.set('loaders', JSON.stringify([loader]));
    const versions = await this.requestJson(
      `${MODRINTH_API}/project/${encodeURIComponent(selection.projectId)}/version?${params}`,
    );
    const version = selection.versionId
      ? (versions || []).find((candidate: any) => String(candidate.id) === selection.versionId)
      : versions?.[0];
    if (!version) throw new Error('Modrinth has no compatible project version for these filters');
    const file = version.files?.find((candidate: any) => candidate.primary) || version.files?.[0];
    if (!file?.url) throw new Error('Modrinth did not provide a downloadable file');
    return {
      provider: 'modrinth',
      projectType: selection.projectType,
      projectId: selection.projectId,
      versionId: String(version.id),
      title: String(version.name || selection.projectId),
      fileName: String(file.filename || ''),
      url: String(file.url),
    };
  }

  private async resolveCurseForge(selection: InstallSelection, profile: any): Promise<DownloadSelection> {
    if (!this.curseForgeKey()) throw new Error('CurseForge is not configured on this panel');
    const params = new URLSearchParams({ pageSize: '50' });
    const gameVersion = selection.gameVersion || profile.gameVersion;
    if (gameVersion) params.set('gameVersion', gameVersion);
    const loader = CURSEFORGE_LOADERS[String(selection.loader || profile.loader || '').toLowerCase()];
    if (loader) params.set('modLoaderType', String(loader));
    const response = await this.requestJson(
      `${CURSEFORGE_API}/mods/${encodeURIComponent(selection.projectId)}/files?${params}`,
      this.curseForgeHeaders(),
    );
    let file = selection.versionId
      ? (response?.data || []).find((candidate: any) => String(candidate.id) === selection.versionId)
      : response?.data?.[0];
    if (!file) throw new Error('CurseForge has no compatible project file for these filters');
    if (selection.projectType === 'modpack') {
      const serverPackId = Number(file.serverPackFileId || (file.isServerPack ? file.id : 0));
      if (!serverPackId) throw new Error('this CurseForge modpack does not publish a server pack');
      if (serverPackId !== Number(file.id)) {
        file = (await this.requestJson(
          `${CURSEFORGE_API}/mods/${encodeURIComponent(selection.projectId)}/files/${serverPackId}`,
          this.curseForgeHeaders(),
        ))?.data;
      }
    }
    let url = String(file?.downloadUrl || '');
    if (!url) {
      url = String((await this.requestJson(
        `${CURSEFORGE_API}/mods/${encodeURIComponent(selection.projectId)}/files/${file.id}/download-url`,
        this.curseForgeHeaders(),
      ))?.data || '');
    }
    if (!url) throw new Error('CurseForge does not allow automated download of this file');
    return {
      provider: 'curseforge',
      projectType: selection.projectType,
      projectId: selection.projectId,
      versionId: String(file.id),
      title: String(file.displayName || selection.projectId),
      fileName: String(file.fileName || ''),
      url,
    };
  }

  private async *download(selection: DownloadSelection): AsyncGenerator<Buffer> {
    const response = await this.response(selection.url);
    const declaredSize = Number(response.headers['content-length'] || 0);
    if (declaredSize > MAX_PROJECT_BYTES) {
      response.destroy();
      throw new Error('project file exceeds the agent 128 MB upload limit');
    }
    let size = 0;
    let prefix = Buffer.alloc(0);
    for await (const raw of response) {
      const chunk = Buffer.from(raw);
      size += chunk.length;
      if (size > MAX_PROJECT_BYTES) {
        response.destroy();
        throw new Error('project file exceeds the agent 128 MB upload limit');
      }
      if (prefix.length < 4) prefix = Buffer.concat([prefix, chunk]).subarray(0, 4);
      yield chunk;
    }
    if (!size || prefix[0] !== 0x50 || prefix[1] !== 0x4b) throw new Error('provider download was not a valid JAR or ZIP file');
  }

  private requestJson(url: string, headers: Record<string, string> = {}) {
    return new Promise<any>((resolve, reject) => {
      const parsed = this.trustedApiUrl(url);
      const request = https.get(parsed, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers } }, response => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`mod provider returned HTTP ${response.statusCode || 0}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) request.destroy(new Error('mod provider response is too large'));
          else chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('mod provider returned invalid JSON')); }
        });
      });
      request.setTimeout(15_000, () => request.destroy(new Error('mod provider request timed out')));
      request.on('error', reject);
    });
  }

  private response(url: string, redirects = 0): Promise<import('http').IncomingMessage> {
    if (redirects > 4) return Promise.reject(new Error('project download redirected too many times'));
    const parsed = this.trustedDownloadUrl(url);
    return new Promise((resolve, reject) => {
      const request = https.get(parsed, { headers: { Accept: 'application/java-archive, application/zip, application/octet-stream', 'User-Agent': USER_AGENT } }, response => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          void this.response(new URL(response.headers.location, parsed).toString(), redirects + 1).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`project download returned HTTP ${response.statusCode || 0}`));
          return;
        }
        resolve(response);
      });
      request.setTimeout(30_000, () => request.destroy(new Error('project download timed out')));
      request.on('error', reject);
    });
  }

  private trustedApiUrl(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['api.modrinth.com', 'api.curseforge.com'].includes(parsed.hostname)) {
      throw new Error('mod provider API source is not trusted');
    }
    return parsed;
  }

  private trustedDownloadUrl(url: string) {
    const parsed = new URL(url);
    const trusted = parsed.hostname === 'cdn.modrinth.com'
      || parsed.hostname === 'mediafilez.forgecdn.net'
      || parsed.hostname.endsWith('.forgecdn.net');
    if (parsed.protocol !== 'https:' || !trusted) throw new Error('project download source is not trusted');
    return parsed;
  }

  private safeFileName(value: string, requiredExtension: '.jar' | '.zip' | '.mrpack') {
    const fileName = String(value || '').split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._+()-]/g, '-') || '';
    if (!fileName.toLowerCase().endsWith(requiredExtension)) {
      throw new Error(`provider did not return a ${requiredExtension} file`);
    }
    return fileName.slice(0, 180);
  }

  private variable(server: ServerRecord, keys: string[]) {
    return keys.map(key => server.variables?.[key]).find(Boolean) || '';
  }

  private curseForgeKey() {
    return String(this.settings.curseForgeApiKey() || '').trim();
  }

  private curseForgeHeaders() {
    return { 'x-api-key': this.curseForgeKey() };
  }

  private curseForgeLoaderName(value: number) {
    return ({ 1: 'forge', 4: 'fabric', 5: 'quilt', 6: 'neoforge' } as Record<number, string>)[Number(value)];
  }
}
