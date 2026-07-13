import { Injectable } from '@nestjs/common';
import { EggsService } from '../../eggs/eggs.service';
import { GameVersionCatalogCacheService } from './game-version-catalog-cache.service';
import { GameEggDescriptor, GameVersionOption, RuntimeArtifact } from './game-version-catalog.types';
import { RuntimeArtifactService } from './runtime-artifact.service';
export type { GameEggDescriptor, GameVersionOption, RuntimeArtifact } from './game-version-catalog.types';

const PAPER_PROJECTS = new Set(['paper', 'folia', 'velocity', 'waterfall']);

const MINECRAFT_PROVIDERS = new Set([
  'vanilla', 'paper', 'purpur', 'spigot', 'bukkit', 'craftbukkit', 'folia',
  'forge', 'neoforge', 'fabric', 'quilt', 'velocity', 'waterfall', 'bungeecord',
  'sponge', 'mohist', 'arclight',
]);

const DIRECT_JAR_PROVIDERS = new Set([
  'vanilla', 'paper', 'folia', 'velocity', 'waterfall', 'purpur', 'fabric',
]);

@Injectable()
export class GameVersionCatalogService {
  constructor(
    private readonly eggs: EggsService,
    private readonly catalogCache: GameVersionCatalogCacheService,
    private readonly artifacts: RuntimeArtifactService,
  ) {}

  async catalog(
    visibleEggIds: readonly string[] | undefined,
    variables: Record<string, string> = {},
    selectedEggId?: string,
    selectedVersion?: string,
  ) {
    // EggsService is hydrated from the database when one is configured and
    // otherwise retains its file-backed catalog. Keeping discovery here means
    // newly imported providers automatically become version choices.
    const installedEggs = new Map<string, any>(
      this.eggs.list().map((egg: any) => [String(egg.id), egg]),
    );
    const eggIds = visibleEggIds === undefined
      ? Array.from(installedEggs.keys())
      : [...new Set(visibleEggIds.map(String))];
    const descriptors = eggIds
      .map(eggId => installedEggs.get(eggId))
      .filter(Boolean)
      .map(egg => this.descriptorFromInstalledEgg(egg, variables))
      .filter((d): d is GameEggDescriptor => Boolean(d));

    const games = Array.from(
      descriptors
        .reduce((groups, d) => {
          const g = groups.get(d.gameId) || { id: d.gameId, name: d.gameName, eggs: [] as GameEggDescriptor[] };
          g.eggs.push(d);
          groups.set(d.gameId, g);
          return groups;
        }, new Map<string, { id: string; name: string; eggs: GameEggDescriptor[] }>())
        .values(),
    )
      .map(g => ({ ...g, eggs: g.eggs.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const selected = descriptors.find(d => d.eggId === selectedEggId) || descriptors[0];
    if (!selected) return { games, selected: undefined };

    try {
      const versions = await this.versionsFor(selected);
      const preferredVersion = selectedVersion || selected.currentVersion;
      const version =
        preferredVersion && versions.some(o => o.id === preferredVersion)
          ? preferredVersion
          : versions[0]?.id || 'latest';
      const builds = await this.buildsFor(selected, version);
      return { games, selected: { eggId: selected.eggId, versions, version, builds } };
    } catch (error: any) {
      const versions = this.fallbackVersions(selected);
      const version = selectedVersion || selected.currentVersion || versions[0]?.id || 'latest';
      return {
        games,
        selected: { eggId: selected.eggId, versions, version, builds: this.fallbackBuilds(selected) },
        warning: error?.message || 'The upstream version catalog is temporarily unavailable.',
      };
    }
  }

  async resolveSelection(eggId: string, selection: any) {
    const descriptor = this.descriptor(eggId, {});
    if (!descriptor) throw new Error(`egg '${eggId}' does not support version selection`);

    const version = this.safeValue(selection?.version, 'version');
    const build = this.safeValue(selection?.build, 'build', true);
    const patch: Record<string, string> = {};

    if (descriptor.versionVariable && version) {
      const versions = await this.versionsFor(descriptor).catch(() => this.fallbackVersions(descriptor));
      if (!versions.some(o => o.id === version))
        throw new Error(`version '${version}' is not available for ${descriptor.name}`);
      patch[descriptor.versionVariable] =
        descriptor.provider === 'steamcmd' && version === 'public' ? '' : version;
    }

    if (descriptor.buildVariable && build) {
      const builds = await this.buildsFor(descriptor, version || 'latest').catch(() =>
        this.fallbackBuilds(descriptor),
      );
      if (!builds.some(o => o.id === build))
        throw new Error(`build '${build}' is not available for ${descriptor.name} ${version}`);
      patch[descriptor.buildVariable] = build;
    }

    return patch;
  }

  async resolveArtifact(eggId: string, selection: any): Promise<RuntimeArtifact> {
    const descriptor = this.descriptor(eggId, {});
    if (!descriptor) throw new Error(`egg '${eggId}' does not support version selection`);
    if (!descriptor.jarInstallSupported) {
      throw new Error(descriptor.jarInstallReason || `${descriptor.name} does not publish a standalone server JAR`);
    }

    const version = this.safeValue(selection?.version, 'version');
    const versions = await this.versionsFor(descriptor);
    if (!versions.some(option => option.id === version)) {
      throw new Error(`version '${version}' is not available for ${descriptor.name}`);
    }

    const builds = await this.buildsFor(descriptor, version);
    const requestedBuild = this.safeValue(selection?.build, 'build', true);
    if (requestedBuild && !builds.some(option => option.id === requestedBuild)) {
      throw new Error(`build '${requestedBuild}' is not available for ${descriptor.name} ${version}`);
    }
    const build = requestedBuild || builds.find(option => option.recommended)?.id || builds[0]?.id;

    if (PAPER_PROJECTS.has(descriptor.provider)) {
      if (!build) throw new Error(`${descriptor.name} ${version} requires a build`);
      const data = await this.requestJson(
        `https://fill.papermc.io/v3/projects/${descriptor.provider}/versions/${encodeURIComponent(version)}/builds`,
      );
      const entry = (Array.isArray(data) ? data : []).find((candidate: any) => String(candidate?.id) === build);
      const url = String(entry?.downloads?.['server:default']?.url || '');
      return this.runtimeArtifact(descriptor.provider, version, build, url);
    }

    if (descriptor.provider === 'purpur') {
      if (!build) throw new Error(`Purpur ${version} requires a build`);
      return this.runtimeArtifact(
        descriptor.provider,
        version,
        build,
        `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/${encodeURIComponent(build)}/download`,
      );
    }

    if (descriptor.provider === 'vanilla') {
      const manifest = await this.requestJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
      const metadataUrl = String((manifest?.versions || []).find((entry: any) => entry?.id === version)?.url || '');
      if (!metadataUrl) throw new Error(`Mojang did not publish metadata for Minecraft ${version}`);
      const metadata = await this.requestJson(metadataUrl);
      return this.runtimeArtifact(descriptor.provider, version, undefined, String(metadata?.downloads?.server?.url || ''));
    }

    if (descriptor.provider === 'fabric') {
      if (!build) throw new Error(`${descriptor.name} ${version} requires a loader build`);
      const base = 'https://meta.fabricmc.net/v2';
      const installers = await this.requestJson(`${base}/versions/installer`);
      const installer = (Array.isArray(installers) ? installers : []).find((entry: any) => entry?.stable !== false)
        || (Array.isArray(installers) ? installers[0] : undefined);
      const installerVersion = String(installer?.version || '');
      if (!installerVersion) throw new Error(`${descriptor.name} did not publish a server launcher installer`);
      return this.runtimeArtifact(
        descriptor.provider,
        version,
        build,
        `${base}/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(build)}/${encodeURIComponent(installerVersion)}/server/jar`,
      );
    }

    throw new Error(`${descriptor.name} does not publish a supported standalone server JAR`);
  }

  async *downloadArtifact(artifact: RuntimeArtifact): AsyncGenerator<Buffer> {
    yield* this.artifacts.download(artifact);
  }

  descriptor(eggId: string, variables: Record<string, string> = {}): GameEggDescriptor | undefined {
    const egg = this.eggs.list().find((c: any) => c.id === eggId) as any;
    if (!egg) return undefined;
    return this.descriptorFromInstalledEgg(egg, variables);
  }

  private descriptorFromInstalledEgg(
    egg: any,
    variables: Record<string, string>,
  ): GameEggDescriptor {
    const provider = this.providerFor(egg);
    const game = this.gameFor(egg, provider);
    const variableNames = new Set<string>(
      (egg.variables || []).map((v: any) => String(v.envVariable || '').toUpperCase()),
    );
    const versionVariable = this.firstVariable(variableNames, this.versionAliases(provider));
    const buildVariable = this.firstVariable(variableNames, this.buildAliases(provider));

    const proxy = ['velocity', 'waterfall', 'bungeecord'].includes(provider);
    const loader = ['forge', 'neoforge', 'fabric', 'quilt'].includes(provider);

    return {
      eggId: egg.id,
      name: egg.name || egg.id,
      description: egg.description,
      gameId: game.id,
      gameName: game.name,
      family: this.familyName(provider, egg.name || egg.id),
      kind: proxy ? 'proxy' : loader ? 'mod-loader' : 'server',
      provider,
      versionLabel: proxy
        ? 'Software version'
        : provider === 'steamcmd'
          ? 'Release channel'
          : game.id === 'minecraft'
            ? 'Minecraft version'
            : 'Game version',
      buildLabel: loader ? 'Loader build' : 'Build',
      versionVariable,
      buildVariable,
      currentVersion: versionVariable ? variables[versionVariable] : undefined,
      currentBuild: buildVariable ? variables[buildVariable] : undefined,
      jarInstallSupported: this.jarInstallSupported(provider),
      jarInstallReason: this.jarInstallReason(provider),
    };
  }

  private async versionsFor(descriptor: GameEggDescriptor): Promise<GameVersionOption[]> {

    if (PAPER_PROJECTS.has(descriptor.provider)) {
      const data = await this.requestJson(
        `https://fill.papermc.io/v3/projects/${descriptor.provider}`,
      );
      const versions = Object.values(data?.versions || {}).flat().map(String);
      return this.options(versions, v => this.experimental(v));
    }

    if (descriptor.provider === 'purpur') {
      const data = await this.requestJson('https://api.purpurmc.org/v2/purpur');
      return this.options((data?.versions || []).map(String), v => this.experimental(v));
    }

    if (descriptor.provider === 'fabric') {
      const data = await this.requestJson('https://meta.fabricmc.net/v2/versions/game');
      return (Array.isArray(data) ? data : []).map((entry: any, i: number) => ({
        id: String(entry.version),
        label: String(entry.version),
        channel: entry.stable === false ? ('experimental' as const) : ('stable' as const),
        recommended: i === 0,
      }));
    }

    // ── Quilt ────────────────────────────────────────────────────────────────
    if (descriptor.provider === 'quilt') {
      const data = await this.requestJson('https://meta.quiltmc.org/v3/versions/game');
      return (Array.isArray(data) ? data : []).map((entry: any, i: number) => ({
        id: String(entry.version || entry),
        label: String(entry.version || entry),
        channel: entry.stable === false ? ('experimental' as const) : ('stable' as const),
        recommended: i === 0,
      }));
    }

    // ── Forge ────────────────────────────────────────────────────────────────
    // Forge's maven metadata lists every MC version that has at least one Forge build.
    if (descriptor.provider === 'forge') {
      const data = await this.requestJson(
        'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json',
      );
      // Keys are MC versions; sort newest-first using semver-ish comparison.
      const mcVersions = Object.keys(data || {}).sort(this.semverDesc);
      return this.options(mcVersions, v => this.experimental(v));
    }

    // ── NeoForge ─────────────────────────────────────────────────────────────
    // NeoForge exposes a Maven metadata XML; parse the <version> tags.
    if (descriptor.provider === 'neoforge') {
      const xml = await this.requestText(
        'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
      );
      // Extract loader versions like "21.1.123"; the MC minor is the first two segments.
      const loaderVersions = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g))
        .map(m => m[1])
        .filter(Boolean)
        .reverse(); // newest first

      // Derive unique MC versions from loader version prefix (e.g. "21.1" → "1.21.1").
      const seen = new Set<string>();
      const mcVersions: string[] = [];
      for (const lv of loaderVersions) {
        const parts = lv.split('.');
        // NeoForge versions: major.minor.patch → MC 1.{major}.{minor}
        const mc = parts.length >= 2 ? `1.${parts[0]}.${parts[1]}` : lv;
        if (!seen.has(mc)) { seen.add(mc); mcVersions.push(mc); }
      }
      return this.options(mcVersions, v => this.experimental(v));
    }

    // ── Spigot / Bukkit / CraftBukkit ────────────────────────────────────────
    // No public build API exists for Spigot/Bukkit — they require BuildTools.
    // We fall back to the Mojang release list so users still see real MC versions
    // and understand what version they're targeting, even though the actual jar
    // is compiled at startup by BuildTools on the server side.
    if (['spigot', 'bukkit', 'craftbukkit'].includes(descriptor.provider)) {
      return this.minecraftReleases(/* snapshotsOnly */ false);
    }

    // ── Mohist (Forge + Bukkit hybrid) ───────────────────────────────────────
    if (descriptor.provider === 'mohist') {
      const data = await this.requestJson('https://api.mohistmc.com/api/v2/projects/mohist');
      const versions: string[] = Array.isArray(data?.versions) ? data.versions.map(String) : [];
      return this.options(versions.reverse(), v => this.experimental(v));
    }

    // ── Arclight (NeoForge + Bukkit hybrid) ──────────────────────────────────
    if (descriptor.provider === 'arclight') {
      const data = await this.requestJson('https://api.mohistmc.com/api/v2/projects/arclight');
      const versions: string[] = Array.isArray(data?.versions) ? data.versions.map(String) : [];
      return this.options(versions.reverse(), v => this.experimental(v));
    }

    // ── SteamCMD (Rust, etc.) ────────────────────────────────────────────────
    if (descriptor.provider === 'steamcmd') return this.fallbackVersions(descriptor);

    // ── Vanilla / generic Minecraft ──────────────────────────────────────────
    if (descriptor.gameId === 'minecraft') return this.minecraftReleases();

    return this.fallbackVersions(descriptor);
  }

  private async buildsFor(descriptor: GameEggDescriptor, version: string): Promise<GameVersionOption[]> {
    if (!descriptor.buildVariable) return [];

    // ── PaperMC family ───────────────────────────────────────────────────────
    if (PAPER_PROJECTS.has(descriptor.provider)) {
      const data = await this.requestJson(
        `https://fill.papermc.io/v3/projects/${descriptor.provider}/versions/${encodeURIComponent(version)}/builds`,
      );
      return (Array.isArray(data) ? data : []).map((entry: any, i: number) => ({
        id: String(entry.id),
        label: `Build ${entry.id}`,
        channel: String(entry.channel).toUpperCase() === 'STABLE' ? ('stable' as const) : ('experimental' as const),
        recommended: i === 0,
      }));
    }

    // ── Purpur ───────────────────────────────────────────────────────────────
    if (descriptor.provider === 'purpur') {
      const data = await this.requestJson(
        `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`,
      );
      const builds = Array.isArray(data?.builds?.all) ? [...data.builds.all].reverse() : [];
      return this.options(builds.map(String), () => false, 'Build ');
    }

    // ── Fabric loader builds for a given MC version ──────────────────────────
    if (descriptor.provider === 'fabric') {
      const data = await this.requestJson(
        `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`,
      );
      return (Array.isArray(data) ? data : []).map((entry: any, i: number) => ({
        id: String(entry?.loader?.version || entry?.version),
        label: String(entry?.loader?.version || entry?.version),
        channel: entry?.loader?.stable === false ? ('experimental' as const) : ('stable' as const),
        recommended: i === 0,
      }));
    }

    // ── Quilt loader builds for a given MC version ───────────────────────────
    if (descriptor.provider === 'quilt') {
      const data = await this.requestJson(
        `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(version)}`,
      );
      return (Array.isArray(data) ? data : []).map((entry: any, i: number) => ({
        id: String(entry?.loader?.version || entry?.version),
        label: String(entry?.loader?.version || entry?.version),
        channel: 'stable' as const,
        recommended: i === 0,
      }));
    }

    // ── Forge builds for a given MC version ──────────────────────────────────
    if (descriptor.provider === 'forge') {
      const data = await this.requestJson(
        'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json',
      );
      // Each key is a MC version; value is an array of full "mcVer-forgeVer" strings.
      const raw: string[] = Array.isArray(data?.[version]) ? data[version] : [];
      // Strip the MC prefix so we just show the Forge build number.
      const builds = raw
        .map(v => v.replace(`${version}-`, ''))
        .reverse(); // newest first
      return this.options(builds, v => this.experimental(v));
    }

    // ── NeoForge builds for a given MC version ────────────────────────────────
    if (descriptor.provider === 'neoforge') {
      const xml = await this.requestText(
        'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
      );
      // MC version "1.21.1" corresponds to NeoForge prefix "21.1."
      const mcParts = version.replace(/^1\./, '').split('.');
      const prefix = mcParts.length >= 2 ? `${mcParts[0]}.${mcParts[1]}.` : '';
      const builds = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g))
        .map(m => m[1])
        .filter(v => prefix ? v.startsWith(prefix) : true)
        .reverse();
      return this.options(builds, v => this.experimental(v));
    }

    // ── Mohist builds for a given MC version ─────────────────────────────────
    if (descriptor.provider === 'mohist') {
      const data = await this.requestJson(
        `https://api.mohistmc.com/api/v2/projects/mohist/${encodeURIComponent(version)}/builds`,
      );
      const builds: any[] = Array.isArray(data?.builds) ? [...data.builds].reverse() : [];
      return builds.map((entry: any, i: number) => ({
        id: String(entry.number),
        label: `Build ${entry.number}`,
        channel: entry.experimental ? ('experimental' as const) : ('stable' as const),
        recommended: i === 0,
      }));
    }

    // ── Arclight builds for a given MC version ────────────────────────────────
    if (descriptor.provider === 'arclight') {
      const data = await this.requestJson(
        `https://api.mohistmc.com/api/v2/projects/arclight/${encodeURIComponent(version)}/builds`,
      );
      const builds: any[] = Array.isArray(data?.builds) ? [...data.builds].reverse() : [];
      return builds.map((entry: any, i: number) => ({
        id: String(entry.number),
        label: `Build ${entry.number}`,
        channel: entry.experimental ? ('experimental' as const) : ('stable' as const),
        recommended: i === 0,
      }));
    }

    return this.fallbackBuilds(descriptor);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async minecraftReleases(includeSnapshots = true): Promise<GameVersionOption[]> {
    const data = await this.requestJson(
      'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    );
    return (data?.versions || [])
      .filter((e: any) => e?.type === 'release' || (includeSnapshots && e?.type === 'snapshot'))
      .map((e: any, i: number) => ({
        id: String(e.id),
        label: String(e.id),
        channel: e.type === 'release' ? ('stable' as const) : ('experimental' as const),
        recommended: i === 0,
      }));
  }

  private fallbackVersions(descriptor: GameEggDescriptor): GameVersionOption[] {
    if (descriptor.provider === 'steamcmd') {
      const values: GameVersionOption[] = [
        { id: 'public', label: 'Public / stable', channel: 'stable', recommended: true },
        { id: 'staging', label: 'Staging', channel: 'experimental' },
        { id: 'aux01', label: 'Auxiliary test branch', channel: 'experimental' },
      ];
      if (descriptor.currentVersion && !values.some(o => o.id === descriptor.currentVersion))
        values.push({ id: descriptor.currentVersion, label: descriptor.currentVersion, channel: 'experimental' });
      return values;
    }
    return this.options(
      Array.from(
        new Set(
          [descriptor.currentVersion, 'latest', descriptor.gameId === 'minecraft' ? 'snapshot' : undefined].filter(
            Boolean,
          ) as string[],
        ),
      ),
      v => v === 'snapshot',
    );
  }

  private fallbackBuilds(descriptor: GameEggDescriptor): GameVersionOption[] {
    if (!descriptor.buildVariable) return [];
    return this.options(
      Array.from(new Set([descriptor.currentBuild, 'latest'].filter(Boolean) as string[])),
      () => false,
      'Build ',
    );
  }

  private options(
    values: string[],
    isExperimental: (v: string) => boolean,
    prefix = '',
  ): GameVersionOption[] {
    return Array.from(new Set(values.filter(Boolean))).map((value, i) => ({
      id: value,
      label: `${prefix}${value}`,
      channel: isExperimental(value) ? 'experimental' : 'stable',
      recommended: i === 0,
    }));
  }

  private providerFor(egg: any): string {
    const text = `${egg.id} ${egg.name} ${egg.description || ''}`.toLowerCase();
    const providers = [
      'neoforge', 'bungeecord', 'waterfall', 'velocity',
      'craftbukkit', 'bukkit', 'arclight', 'mohist',
      'purpur', 'spigot', 'folia', 'forge', 'fabric', 'quilt', 'paper',
    ];
    const found = providers.find(p => text.includes(p));
    if (found) return found;
    if (/vanilla|mojang/.test(text)) return 'vanilla';
    if (/rust/.test(text)) return 'steamcmd';
    return 'generic';
  }

  private gameFor(egg: any, provider: string) {
    const text = `${egg.nestName || ''} ${egg.name || ''} ${egg.description || ''}`.toLowerCase();
    if (MINECRAFT_PROVIDERS.has(provider) || text.includes('minecraft'))
      return { id: 'minecraft', name: 'Minecraft' };
    if (provider === 'steamcmd' && text.includes('rust')) return { id: 'rust', name: 'Rust' };
    const name = String(egg.nestName || egg.name || 'Other').trim();
    return {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other',
      name,
    };
  }

  private versionAliases(provider: string): string[] {
    const specific: Record<string, string[]> = {
      vanilla: ['VANILLA_VERSION'],
      velocity: ['VELOCITY_VERSION'],
      waterfall: ['WATERFALL_VERSION'],
      bungeecord: ['BUNGEE_VERSION'],
      fabric: ['MC_VERSION'],
      quilt: ['MC_VERSION'],
      forge: ['MC_VERSION'],
      neoforge: ['MC_VERSION'],
      spigot: ['SPIGOT_VERSION'],
      bukkit: ['BUKKIT_VERSION'],
      craftbukkit: ['BUKKIT_VERSION'],
      mohist: ['MC_VERSION'],
      arclight: ['MC_VERSION'],
      steamcmd: ['SRCDS_BETAID'],
    };
    return [
      ...(specific[provider] || []),
      'MINECRAFT_VERSION', 'MC_VERSION', 'SERVER_VERSION', 'GAME_VERSION', 'VERSION',
    ];
  }

  private buildAliases(provider: string): string[] {
    const specific: Record<string, string[]> = {
      fabric: ['LOADER_VERSION', 'FABRIC_LOADER_VERSION'],
      quilt: ['LOADER_VERSION', 'QUILT_LOADER_VERSION'],
      forge: ['FORGE_VERSION'],
      neoforge: ['NEOFORGE_VERSION'],
    };
    return [...(specific[provider] || []), 'BUILD_NUMBER', 'SERVER_BUILD', 'BUILD'];
  }

  private firstVariable(names: Set<string>, aliases: string[]): string | undefined {
    return aliases.find(a => names.has(a));
  }

  private familyName(provider: string, fallback: string): string {
    const names: Record<string, string> = {
      vanilla: 'Vanilla',
      paper: 'Paper',
      purpur: 'Purpur',
      spigot: 'Spigot',
      bukkit: 'Bukkit',
      craftbukkit: 'CraftBukkit',
      folia: 'Folia',
      forge: 'Forge',
      neoforge: 'NeoForge',
      fabric: 'Fabric',
      quilt: 'Quilt',
      velocity: 'Velocity',
      waterfall: 'Waterfall',
      bungeecord: 'BungeeCord',
      mohist: 'Mohist',
      arclight: 'Arclight',
      steamcmd: 'SteamCMD',
    };
    return names[provider] || fallback;
  }

  private jarInstallSupported(provider: string) {
    return DIRECT_JAR_PROVIDERS.has(provider);
  }

  private jarInstallReason(provider: string): string | undefined {
    if (this.jarInstallSupported(provider)) return undefined;
    if (['spigot', 'bukkit', 'craftbukkit'].includes(provider)) {
      return 'Spigot and Bukkit require BuildTools and do not publish a standalone server JAR. Use the egg installer.';
    }
    if (['forge', 'neoforge'].includes(provider)) {
      return 'Forge and NeoForge require an installer that also creates libraries and launch scripts. Use the egg installer.';
    }
    if (provider === 'quilt') {
      return 'Quilt requires its installer and server launcher metadata. Use the egg installer.';
    }
    return 'This provider does not publish a verified standalone server JAR. Use the egg installer.';
  }

  private runtimeArtifact(provider: string, version: string, build: string | undefined, url: string): RuntimeArtifact {
    return this.artifacts.artifact(provider, version, build, url);
  }

  private experimental(value: string): boolean {
    return /snapshot|pre|rc|beta|alpha/i.test(value);
  }

  /** Descending semver-ish sort for MC version strings like "1.21.1", "1.8". */
  private semverDesc(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  private safeValue(value: unknown, label: string, optional = false): string {
    const text = String(value ?? '').trim();
    if (!text && optional) return '';
    if (!text || !/^[a-z0-9._+:-]{1,80}$/i.test(text)) throw new Error(`${label} is invalid`);
    return text;
  }

  private requestJson(url: string): Promise<any> {
    return this.catalogCache.requestJson(url);
  }

  private requestText(url: string): Promise<string> {
    return this.catalogCache.requestText(url);
  }
}
