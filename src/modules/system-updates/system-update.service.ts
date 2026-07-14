import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { ApiConfigService } from '../../common/config/config.service';
import {
  AgentReleaseManifest,
  PanelComponent,
  PanelReleaseManifest,
  PanelUpdateState,
  ReleaseComponent,
  StagedArtifact,
  UpdateArtifact,
} from './system-update.types';

const STATE_NAMESPACE = 'panel-update-state';
const PANEL_COMPONENTS: PanelComponent[] = ['api', 'frontend'];
const DEFAULT_RELEASE_SOURCES: Record<ReleaseComponent, string> = {
  api: 'https://github.com/agapornis-dev/agapornis-api/releases/latest/download/release-manifest.json',
  frontend: 'https://github.com/agapornis-dev/agapornis-frontend/releases/latest/download/release-manifest.json',
  agent: 'https://github.com/agapornis-dev/agapornis-agent-rust/releases/latest/download/release-manifest.json',
};

type AnyReleaseManifest = PanelReleaseManifest | AgentReleaseManifest;
type SelectedPanelRelease = { component: PanelComponent; manifest: PanelReleaseManifest };
type ExternalResult = {
  status: 'completed' | 'failed';
  completedAt?: string;
  failedAt?: string;
  errorMessage?: string;
  targetVersions?: Partial<Record<PanelComponent, string>>;
};

@Injectable()
export class SystemUpdateService implements OnModuleInit {
  private readonly logger = new Logger(SystemUpdateService.name);
  private readonly updateRoot: string;
  private readonly stateFile: string;
  private readonly currentJobFile: string;
  private readonly resultFile: string;
  private state: PanelUpdateState = { status: 'idle' };
  private readonly manifestCache = new Map<ReleaseComponent, { manifest: AnyReleaseManifest; expiresAt: number }>();
  private observedFrontendVersion?: string;

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ApiConfigService = new ApiConfigService(),
  ) {
    this.updateRoot = path.resolve(this.config.get('AGAPORNIS_PANEL_UPDATE_DIR', path.join(__dirname, '..', '..', 'data', 'panel-updates')));
    this.stateFile = path.join(this.updateRoot, 'state.json');
    this.currentJobFile = path.join(this.updateRoot, 'current-job.json');
    this.resultFile = path.join(this.updateRoot, 'result.json');
  }

  async onModuleInit() {
    await fsp.mkdir(this.updateRoot, { recursive: true });
    const local = this.readJson<PanelUpdateState>(this.stateFile);
    const stored = this.database.enabled ? await this.database.loadCollection<PanelUpdateState>(STATE_NAMESPACE) : [];
    this.state = stored[0] || local || { status: 'idle' };
    if (await this.reconcileState()) await this.persistState();
  }

  async status(force = false, frontendVersion?: string) {
    this.observeFrontendVersion(frontendVersion);
    await this.refreshSharedState();

    const current = this.currentVersions();
    const managedComponents = this.managedComponents();
    const releases = {} as Partial<Record<PanelComponent, PanelReleaseManifest>>;
    const manifestErrors = {} as Partial<Record<PanelComponent, string>>;
    await Promise.all(PANEL_COMPONENTS.map(async component => {
      try { releases[component] = await this.panelManifest(component, force); }
      catch (error: any) { manifestErrors[component] = error?.message || `${component} release manifest unavailable`; }
    }));

    const components = Object.fromEntries(PANEL_COMPONENTS.map(component => {
      const manifest = releases[component];
      return [component, {
        currentVersion: current[component],
        latestVersion: manifest?.version,
        updateAvailable: manifest ? this.compareVersions(manifest.version, current[component]) > 0 : false,
        managed: managedComponents.includes(component),
        releaseSource: this.releaseSource(component),
        manifest,
        manifestError: manifestErrors[component],
      }];
    }));

    return {
      configured: true,
      deployCommandConfigured: Boolean(this.applyCommand()),
      managedComponents,
      releaseSources: Object.fromEntries(PANEL_COMPONENTS.map(component => [component, this.releaseSource(component)])),
      current,
      components,
      updateAvailable: PANEL_COMPONENTS.some(component => components[component].updateAvailable),
      deployableUpdateAvailable: managedComponents.some(component => components[component].updateAvailable),
      manifestErrors,
      state: this.state,
    };
  }

  async deploy(frontendVersion?: string) {
    const locked = await this.redis.withLock('panel-update-deploy', 30 * 60_000, async () => {
      this.observeFrontendVersion(frontendVersion);
      await this.refreshSharedState();
      if (['staging', 'staged', 'applying'].includes(this.state.status)) throw new Error('a panel update is already in progress');
      const command = this.applyCommand();
      const managedComponents = this.managedComponents();

      const current = this.currentVersions();
      const selected: SelectedPanelRelease[] = [];
      const unavailable: string[] = [];
      for (const component of managedComponents) {
        try {
          const manifest = await this.panelManifest(component, true);
          if (this.compareVersions(manifest.version, current[component]) > 0) selected.push({ component, manifest });
        } catch (error: any) {
          unavailable.push(`${component}: ${error?.message || 'release manifest unavailable'}`);
        }
      }
      if (!selected.length) {
        if (unavailable.length) throw new Error(`no deployable panel update was found (${unavailable.join('; ')})`);
        throw new Error('the panel components managed by this updater are already current');
      }

      const targetVersions = Object.fromEntries(selected.map(({ component, manifest }) => [component, manifest.version]));
      this.state = {
        status: 'staging',
        targetVersions,
        startedAt: new Date().toISOString(),
      };
      await this.persistState();

      try {
        const stagingDirectory = await this.stage(selected);
        this.state = {
          ...this.state,
          status: 'staged',
          stagedAt: new Date().toISOString(),
          manualApplyRequired: !command,
          errorMessage: command
            ? undefined
            : 'Automatic deployment is unavailable. The verified update is staged and must be applied manually with: sudo systemctl start agapornis-panel-update.service',
          artifacts: selected.map(({ component, manifest }) => this.stagedArtifact(stagingDirectory, component, manifest.artifact)),
        };
        await this.persistState();
        const environment = await this.writeApplyJob(stagingDirectory, selected);
        if (command) await this.scheduleApply(command, environment);
        return {
          message: command
            ? `${selected.map(({ component, manifest }) => `${component} ${manifest.version}`).join(' and ')} verified and handed to the deployment supervisor`
            : `${selected.map(({ component, manifest }) => `${component} ${manifest.version}`).join(' and ')} verified and staged; manual installation is required`,
          state: this.state,
        };
      } catch (error: any) {
        await this.markFailed(error?.message || 'panel update failed');
        throw error;
      }
    });
    if (!locked.acquired) throw new Error('another API replica is coordinating a panel update');
    return locked.result;
  }

  async agentRelease(force = false) {
    return this.agentManifest(force);
  }

  async agentArtifact(runtime: string) {
    const manifest = await this.agentManifest();
    const normalized = String(runtime || '').trim().toLowerCase();
    const artifact = manifest.artifacts[normalized];
    if (!artifact) throw new Error(`agent release ${manifest.version} has no artifact for ${normalized || 'unknown runtime'}`);
    return { ...artifact, version: manifest.version, runtime: normalized };
  }

  async hasAgentArtifacts() {
    try { return Object.keys((await this.agentManifest()).artifacts).length > 0; }
    catch { return false; }
  }

  compareReleaseVersions(left: string, right: string) {
    return this.compareVersions(left, right);
  }

  private async panelManifest(component: PanelComponent, force = false) {
    return this.manifest(component, force) as Promise<PanelReleaseManifest>;
  }

  private async agentManifest(force = false) {
    return this.manifest('agent', force) as Promise<AgentReleaseManifest>;
  }

  private async manifest(component: ReleaseComponent, force = false): Promise<AnyReleaseManifest> {
    const cached = this.manifestCache.get(component);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.manifest;
    const raw = await this.readUrl(this.releaseSource(component), 1024 * 1024, 30_000);
    let parsed: any;
    try { parsed = JSON.parse(raw.toString('utf8')); }
    catch { throw new Error(`${component} release manifest is not valid JSON`); }
    const manifest = this.validateManifest(parsed, component);
    this.manifestCache.set(component, { manifest, expiresAt: Date.now() + 5 * 60_000 });
    return manifest;
  }

  private validateManifest(input: any, expectedComponent: ReleaseComponent): AnyReleaseManifest {
    if (Number(input?.schemaVersion) !== 1) throw new Error(`${expectedComponent} release manifest schema is unsupported`);
    const component = String(input?.component || '').trim().toLowerCase();
    if (component !== expectedComponent) throw new Error(`${expectedComponent} release manifest identifies component ${component || 'unknown'}`);
    const version = String(input?.version || '').trim();
    if (!/^[0-9][0-9A-Za-z._-]{0,63}$/.test(version)) throw new Error(`${component} release manifest version is invalid`);
    const base = {
      schemaVersion: 1 as const,
      component: expectedComponent,
      version,
      channel: String(input?.channel || 'stable').slice(0, 32),
      publishedAt: input?.publishedAt ? String(input.publishedAt).slice(0, 64) : undefined,
      releaseNotes: input?.releaseNotes ? String(input.releaseNotes).slice(0, 20_000) : undefined,
      releaseUrl: input?.releaseUrl ? String(input.releaseUrl).slice(0, 2048) : undefined,
    };
    if (expectedComponent === 'agent') {
      return { ...base, component: 'agent', artifacts: this.validateArtifacts(input?.artifacts, 'agent') };
    }
    return {
      ...base,
      component: expectedComponent,
      artifact: this.validateArtifact(input?.artifact, `${expectedComponent} release`),
    };
  }

  private validateArtifacts(input: any, label: string): Record<string, UpdateArtifact> {
    const result: Record<string, UpdateArtifact> = {};
    for (const [key, value] of Object.entries(input || {})) {
      const name = String(key).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) throw new Error(`${label} artifact key is invalid`);
      result[name] = this.validateArtifact(value, `${name} ${label}`);
    }
    if (!Object.keys(result).length) throw new Error(`${label} artifacts cannot be empty`);
    return result;
  }

  private validateArtifact(value: any, label: string): UpdateArtifact {
    const url = String(value?.url || '').trim();
    const sha256 = String(value?.sha256 || '').trim().toLowerCase();
    this.validateRemoteUrl(url, `${label} artifact`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label} artifact requires a SHA-256 checksum`);
    const sizeBytes = value?.sizeBytes == null ? undefined : Number(value.sizeBytes);
    if (sizeBytes != null && (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)) throw new Error(`${label} artifact size is invalid`);
    return { url, sha256, sizeBytes };
  }

  private async stage(selected: SelectedPanelRelease[]) {
    const nonce = `${Date.now()}-${randomBytes(5).toString('hex')}`;
    const directory = path.join(this.updateRoot, `panel-${nonce}`);
    await fsp.mkdir(directory, { recursive: true });
    for (const { component, manifest } of selected) {
      await this.downloadArtifact(component, manifest.artifact, path.join(directory, `${component}.artifact`));
    }
    await fsp.writeFile(path.join(directory, 'releases.json'), JSON.stringify(
      Object.fromEntries(selected.map(({ component, manifest }) => [component, manifest])), null, 2,
    ), { mode: 0o600 });
    return directory;
  }

  private async downloadArtifact(component: PanelComponent, artifact: UpdateArtifact, target: string) {
    const maximum = this.maxArtifactBytes();
    if (artifact.sizeBytes && artifact.sizeBytes > maximum) throw new Error(`${component} artifact exceeds the configured size limit`);
    const response = await this.openUrl(artifact.url, 15 * 60_000);
    const advertised = Number(response.headers.get('content-length') || 0);
    if (advertised > maximum) throw new Error(`${component} artifact exceeds the configured size limit`);
    if (!response.body) throw new Error(`${component} artifact returned an empty response`);

    const file = await fsp.open(target, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        size += chunk.length;
        if (size > maximum) throw new Error(`${component} artifact exceeds the configured size limit`);
        hash.update(chunk);
        await file.write(chunk);
      }
      await file.sync();
    } catch (error) {
      await file.close().catch(() => undefined);
      await fsp.unlink(target).catch(() => undefined);
      throw error;
    }
    await file.close();
    const actual = hash.digest();
    const expected = Buffer.from(artifact.sha256, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      await fsp.unlink(target).catch(() => undefined);
      throw new Error(`${component} artifact checksum mismatch`);
    }
    if (artifact.sizeBytes && size !== artifact.sizeBytes) {
      await fsp.unlink(target).catch(() => undefined);
      throw new Error(`${component} artifact size did not match the manifest`);
    }
  }

  private async readUrl(url: string, maximum: number, timeoutMs: number) {
    const response = await this.openUrl(url, timeoutMs);
    const advertised = Number(response.headers.get('content-length') || 0);
    if (advertised > maximum) throw new Error('release manifest exceeds the size limit');
    if (!response.body) throw new Error('release manifest returned an empty response');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      size += chunk.length;
      if (size > maximum) throw new Error('release manifest exceeds the size limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  private async openUrl(input: string, timeoutMs: number) {
    let current = input;
    const signal = AbortSignal.timeout(timeoutMs);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      this.validateRemoteUrl(current, 'update URL');
      const response = await fetch(current, { redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('update URL exceeded the redirect limit');
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`update download failed with HTTP ${response.status}`);
      return response;
    }
    throw new Error('update URL exceeded the redirect limit');
  }

  private validateRemoteUrl(value: string, label: string) {
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { throw new Error(`${label} URL is invalid`); }
    const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(!this.config.isProduction() && parsed.protocol === 'http:' && loopback)) {
      throw new Error(`${label} URL must use HTTPS`);
    }
  }

  private async writeApplyJob(stagingDirectory: string, selected: SelectedPanelRelease[]) {
    const updates = Object.fromEntries(selected.map(({ component, manifest }) => [component, {
      version: manifest.version,
      artifactPath: path.join(stagingDirectory, `${component}.artifact`),
      sha256: manifest.artifact.sha256,
      sizeBytes: manifest.artifact.sizeBytes,
    }]));
    const job = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      updateRoot: this.updateRoot,
      stagingDirectory,
      resultFile: this.resultFile,
      updates,
    };
    const temporaryJob = `${this.currentJobFile}.${process.pid}.tmp`;
    await fsp.writeFile(temporaryJob, JSON.stringify(job, null, 2), { mode: 0o600 });
    await fsp.rename(temporaryJob, this.currentJobFile);

    return {
      ...this.config.all(),
      AGAPORNIS_UPDATE_JOB: this.currentJobFile,
      AGAPORNIS_UPDATE_STAGING_DIR: stagingDirectory,
      AGAPORNIS_UPDATE_API_ARTIFACT: updates.api?.artifactPath || '',
      AGAPORNIS_UPDATE_FRONTEND_ARTIFACT: updates.frontend?.artifactPath || '',
      AGAPORNIS_UPDATE_API_VERSION: updates.api?.version || '',
      AGAPORNIS_UPDATE_FRONTEND_VERSION: updates.frontend?.version || '',
    };
  }

  private async scheduleApply(command: string, environment: NodeJS.ProcessEnv) {
    this.state = {
      ...this.state,
      status: 'applying',
      applyStartedAt: new Date().toISOString(),
      manualApplyRequired: false,
      errorMessage: undefined,
    };
    await this.persistState();
    await fsp.unlink(this.resultFile).catch(() => undefined);

    const args = this.applyArguments();
    const timer = setTimeout(() => {
      try {
        const child = spawn(command, args, {
          cwd: this.config.get('AGAPORNIS_PANEL_UPDATE_COMMAND_CWD', process.cwd()),
          detached: false,
          shell: false,
          stdio: 'ignore',
          env: environment,
          windowsHide: true,
        });
        child.once('error', error => {
          this.logger.error(`Panel update command failed to start: ${error.message}`);
          void this.markFailed(error.message);
        });
        child.once('exit', code => {
          if (code && code !== 0) {
            const message = `panel update supervisor command exited with status ${code}`;
            this.logger.error(message);
            void this.markFailed(message);
          }
        });
        child.unref();
      } catch (error: any) {
        this.logger.error(`Panel update command failed to start: ${error?.message || error}`);
        void this.markFailed(error?.message || 'deployment command failed to start');
      }
    }, 750);
    timer.unref?.();
  }

  private stagedArtifact(directory: string, component: PanelComponent, artifact: UpdateArtifact): StagedArtifact {
    const file = path.join(directory, `${component}.artifact`);
    return { component, path: file, sha256: artifact.sha256, sizeBytes: fs.statSync(file).size };
  }

  private currentVersions() {
    return {
      api: String(this.config.get('AGAPORNIS_API_VERSION') || this.packageVersion(path.join(__dirname, '..', '..', '..', 'package.json')) || this.packageVersion(path.join(process.cwd(), 'package.json')) || 'unknown'),
      frontend: String(this.config.get('AGAPORNIS_FRONTEND_VERSION') || this.observedFrontendVersion || 'unknown'),
    };
  }

  private observeFrontendVersion(value?: string) {
    const normalized = String(value || '').trim();
    if (/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(normalized)) this.observedFrontendVersion = normalized;
  }

  private packageVersion(file: string) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8'))?.version; }
    catch { return undefined; }
  }

  private applyCommand() {
    return this.config.get('AGAPORNIS_PANEL_UPDATE_COMMAND').trim();
  }

  private managedComponents(): PanelComponent[] {
    const configured = this.config.get('AGAPORNIS_PANEL_UPDATE_COMPONENTS', 'api');
    const requested = configured.split(',').map(value => value.trim().toLowerCase());
    const managed = PANEL_COMPONENTS.filter(component => requested.includes(component));
    return managed.length ? managed : ['api'];
  }

  private applyArguments(): string[] {
    const raw = this.config.get('AGAPORNIS_PANEL_UPDATE_ARGS', '[]');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('AGAPORNIS_PANEL_UPDATE_ARGS must be a JSON array'); }
    if (!Array.isArray(parsed) || parsed.length > 32 || parsed.some(value => typeof value !== 'string')) {
      throw new Error('AGAPORNIS_PANEL_UPDATE_ARGS must contain at most 32 string arguments');
    }
    return parsed as string[];
  }

  private releaseSource(component: ReleaseComponent) {
    const variable = `AGAPORNIS_${component.toUpperCase()}_RELEASE_MANIFEST_URL`;
    return this.config.get(variable, DEFAULT_RELEASE_SOURCES[component]).trim();
  }

  private maxArtifactBytes() {
    const value = this.config.int('AGAPORNIS_PANEL_UPDATE_MAX_BYTES', 512 * 1024 * 1024);
    return Number.isSafeInteger(value) && value > 0 ? value : 512 * 1024 * 1024;
  }

  private compareVersions(left: string, right: string) {
    if (!left || !right || right === 'unknown') return left && right !== left ? 1 : 0;
    const parts = (value: string) => value.replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(part => Number(part) || 0);
    const a = parts(left), b = parts(right);
    for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    return left.replace(/^v/i, '') === right.replace(/^v/i, '') ? 0 : 1;
  }

  private async reconcileState() {
    let changed = false;
    if (!this.state.targetVersions && this.state.targetVersion) {
      this.state.targetVersions = { api: this.state.targetVersion, frontend: this.state.targetVersion };
      changed = true;
    }
    if (this.reconcileExternalResult()) changed = true;
    if (!this.state.targetVersions || !['staged', 'applying'].includes(this.state.status)) return changed;
    const current = this.currentVersions();
    const targets = Object.entries(this.state.targetVersions) as [PanelComponent, string][];
    if (targets.length && targets.every(([component, version]) => this.compareVersions(current[component], version) >= 0)) {
      this.state = { ...this.state, status: 'completed', completedAt: new Date().toISOString(), manualApplyRequired: false, errorMessage: undefined };
      return true;
    }
    const started = Date.parse(this.state.applyStartedAt || this.state.startedAt || '');
    const timeoutMs = this.config.positiveInt('AGAPORNIS_PANEL_UPDATE_TIMEOUT_MS', 60 * 60_000);
    if (this.state.status === 'applying' && Number.isFinite(started) && Date.now() - started > timeoutMs) {
      this.state = {
        ...this.state,
        status: 'failed',
        failedAt: new Date().toISOString(),
        errorMessage: `native update supervisor did not report a result within ${Math.round(timeoutMs / 60_000)} minutes`,
      };
      return true;
    }
    return changed;
  }

  private reconcileExternalResult() {
    if (!['staged', 'applying'].includes(this.state.status)) return false;
    const result = this.readJson<ExternalResult>(this.resultFile);
    if (!result || !['completed', 'failed'].includes(result.status)) return false;
    if (result.targetVersions) {
      const targets = Object.entries(this.state.targetVersions || {}) as [PanelComponent, string][];
      if (targets.some(([component, version]) => result.targetVersions?.[component] !== version)) return false;
    }
    if (result.status === 'failed') {
      this.state = {
        ...this.state,
        status: 'failed',
        failedAt: result.failedAt || new Date().toISOString(),
        errorMessage: result.errorMessage || 'native panel rollout failed and was rolled back',
      };
    } else {
      this.state = {
        ...this.state,
        status: 'completed',
        completedAt: result.completedAt || new Date().toISOString(),
        manualApplyRequired: false,
        errorMessage: undefined,
      };
    }
    return true;
  }

  private async refreshSharedState() {
    if (this.database.enabled) {
      const stored = await this.database.loadCollection<PanelUpdateState>(STATE_NAMESPACE);
      if (stored[0]) this.state = stored[0];
    }
    if (await this.reconcileState()) await this.persistState();
  }

  private async markFailed(message: string) {
    this.state = { ...this.state, status: 'failed', failedAt: new Date().toISOString(), errorMessage: message };
    await this.persistState();
  }

  private readJson<T>(file: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return undefined; }
  }

  private async persistState() {
    await fsp.mkdir(this.updateRoot, { recursive: true });
    await fsp.writeFile(this.stateFile, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await this.database.replaceCollection(STATE_NAMESPACE, [this.state], () => 'current');
  }
}
