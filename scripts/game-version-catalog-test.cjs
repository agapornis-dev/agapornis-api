const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { GameVersionCatalogService } = require('../src/modules/servers/services/game-version-catalog.service.ts');
const { GameVersionCatalogCacheService } = require('../src/modules/servers/services/game-version-catalog-cache.service.ts');
const { RuntimeArtifactService } = require('../src/modules/servers/services/runtime-artifact.service.ts');
const { ServerSettingsController } = require('../src/modules/servers/controllers/server-settings.controller.ts');

async function main() {
  const installedEggs = [
    {
      id: 'paper', name: 'Paper', nestName: 'Minecraft', description: 'High performance Minecraft server',
      variables: [
        { envVariable: 'MINECRAFT_VERSION', defaultValue: 'latest', userEditable: true },
        { envVariable: 'BUILD_NUMBER', defaultValue: 'latest', userEditable: true }
      ]
    },
    {
      id: 'fabric', name: 'Fabric', nestName: 'Minecraft', description: 'Fabric mod loader',
      variables: [{ envVariable: 'MC_VERSION' }, { envVariable: 'LOADER_VERSION' }]
    },
    {
      id: 'rust', name: 'Rust', nestName: 'Rust', description: 'Rust dedicated server through SteamCMD',
      variables: [{ envVariable: 'SRCDS_BETAID' }]
    },
    {
      id: 'spigot', name: 'Spigot', nestName: 'Minecraft', description: 'Spigot through BuildTools',
      variables: [{ envVariable: 'SPIGOT_VERSION' }]
    },
    {
      id: 'neoforge', name: 'NeoForge', nestName: 'Minecraft', description: 'NeoForge mod loader',
      variables: [{ envVariable: 'MC_VERSION' }, { envVariable: 'NEOFORGE_VERSION' }]
    }
  ];
  const eggs = { list: () => installedEggs };
  const service = new GameVersionCatalogService(eggs, {}, new RuntimeArtifactService());

  service.versionsFor = async () => [{ id: 'latest', label: 'latest', channel: 'stable' }];
  service.buildsFor = async () => [];
  const installedCatalog = await service.catalog(['paper', 'paper', 'bundled-but-not-installed']);
  assert.deepEqual(installedCatalog.games.flatMap(game => game.eggs.map(egg => egg.eggId)), ['paper']);
  const completeInstalledCatalog = await service.catalog(undefined);
  assert.deepEqual(
    completeInstalledCatalog.games.flatMap(game => game.eggs.map(egg => egg.eggId)).sort(),
    ['fabric', 'neoforge', 'paper', 'rust', 'spigot'],
    'catalog discovery should include every database/file-backed installed egg'
  );

  const paper = service.descriptor('paper', { MINECRAFT_VERSION: '1.21.8', BUILD_NUMBER: '60' });
  assert.equal(paper.gameId, 'minecraft');
  assert.equal(paper.provider, 'paper');
  assert.equal(paper.versionVariable, 'MINECRAFT_VERSION');
  assert.equal(paper.buildVariable, 'BUILD_NUMBER');
  assert.equal(paper.currentVersion, '1.21.8');

  const rust = service.descriptor('rust', {});
  assert.equal(rust.gameId, 'rust');
  assert.equal(rust.versionLabel, 'Release channel');
  assert.equal(rust.versionVariable, 'SRCDS_BETAID');

  assert.equal(service.descriptor('paper', {}).jarInstallSupported, true);
  assert.equal(service.descriptor('spigot', {}).jarInstallSupported, false);
  assert.match(service.descriptor('spigot', {}).jarInstallReason, /BuildTools/);
  assert.match(service.descriptor('neoforge', {}).jarInstallReason, /libraries and launch scripts/);

  service.versionsFor = async () => [
    { id: '1.21.8', label: '1.21.8', channel: 'stable' },
    { id: '1.21.9-rc1', label: '1.21.9-rc1', channel: 'experimental' }
  ];
  service.buildsFor = async () => [{ id: '60', label: 'Build 60', channel: 'stable' }];
  assert.deepEqual(await service.resolveSelection('paper', { version: '1.21.8', build: '60' }), {
    MINECRAFT_VERSION: '1.21.8', BUILD_NUMBER: '60'
  });
  await assert.rejects(service.resolveSelection('paper', { version: '1.20.1', build: '60' }), /not available/);
  service.requestJson = async () => [{
    id: 60,
    downloads: { 'server:default': { url: 'https://fill-data.papermc.io/v1/objects/example/paper.jar' } }
  }];
  const artifact = await service.resolveArtifact('paper', { version: '1.21.8', build: '60' });
  assert.equal(artifact.provider, 'paper');
  assert.equal(artifact.fileName, 'server.jar');
  await assert.rejects(service.resolveArtifact('spigot', { version: '1.21.8' }), /BuildTools/);

  let catalogCalls = 0;
  const versions = { catalog: async ids => { catalogCalls += 1; return { games: [], ids }; } };
  let server = { id: 'server-1', nodeId: 'node-1', eggId: 'paper', eggChangeAllowed: false, allowedEggIds: ['fabric'], variables: {} };
  const support = {
    requireNodeServerPermission: async () => server,
    canManageResources: user => ['owner', 'admin'].includes(user?.role)
  };
  const registry = { canManageAccess: () => true };
  const controller = new ServerSettingsController({}, eggs, registry, {}, support, versions);
  assert.equal(controller.runtimeJarPath('java -Xmx2G -jar custom-server.jar nogui', {}), 'custom-server.jar');
  assert.throws(() => controller.runtimeJarPath('java -jar ../server.jar', {}), /safe server JAR path/);
  const disabled = await controller.versionCatalog('node-1', 'server-1', undefined, undefined, { user: { id: 'owner-1', role: 'user' } });
  assert.equal(disabled.enabled, true);
  assert.deepEqual(disabled.ids, ['paper'], 'a fixed egg plan may browse versions for its current egg');
  assert.equal(catalogCalls, 1);

  server = { ...server, eggChangeAllowed: true };
  const enabled = await controller.versionCatalog('node-1', 'server-1', 'fabric', undefined, { user: { id: 'owner-1', role: 'user' } });
  assert.equal(enabled.enabled, true);
  assert.deepEqual(enabled.ids.sort(), ['fabric', 'paper']);
  await assert.rejects(
    controller.versionCatalog('node-1', 'server-1', 'rust', undefined, { user: { id: 'owner-1', role: 'user' } }),
    /not allowed/
  );

  server = { ...server, allowedEggIds: [] };
  const unrestrictedOwnerCatalog = await controller.versionCatalog('node-1', 'server-1', 'neoforge', undefined, { user: { id: 'owner-1', role: 'user' } });
  assert.deepEqual(unrestrictedOwnerCatalog.ids.sort(), ['fabric', 'neoforge', 'paper', 'rust', 'spigot']);

  const adminCatalog = await controller.versionCatalog('node-1', 'server-1', 'neoforge', undefined, { user: { id: 'admin-1', role: 'admin' } });
  assert.deepEqual(adminCatalog.ids.sort(), ['fabric', 'neoforge', 'paper', 'rust', 'spigot']);

  const persisted = new Map();
  const database = {
    enabled: true,
    clientType: 'postgres',
    placeholders: count => Array.from({ length: count }, (_, index) => `$${index + 1}`).join(', '),
    query: async (sql, params = []) => {
      if (/^\s*CREATE TABLE/i.test(sql)) return [];
      if (/^\s*SELECT/i.test(sql)) return persisted.has(params[0]) ? [persisted.get(params[0])] : [];
      if (/^\s*INSERT/i.test(sql)) {
        persisted.set(params[0], { response_text: params[1], expires_at: params[2] });
        return [];
      }
      return [];
    }
  };
  const cachedService = new GameVersionCatalogCacheService(database);
  await cachedService.onModuleInit();
  await cachedService.writeDatabase('https://example.invalid/catalog', { value: '{"ok":true}', expiresAt: Date.now() + 60_000 });
  const cached = await cachedService.readDatabase('https://example.invalid/catalog');
  assert.equal(cached.value, '{"ok":true}');

  console.log('Game version catalog self-test passed: providers, JAR install policy, fixed-egg browsing, and database caching are enforced.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
