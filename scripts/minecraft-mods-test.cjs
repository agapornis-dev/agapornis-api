require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { MinecraftModsService } = require('../src/modules/servers/services/minecraft-mods.service');

async function main() {
  const uploads = [];
  const deleted = [];
  const client = {
    listDirectory: async () => ({
      items: [
        { name: 'fabric-api.jar', size: 1200, last_modified: '2026-01-01T00:00:00Z' },
        { name: 'disabled-mod.jar.disabled', size: 500 },
        { name: 'config', is_directory: true },
        { name: 'notes.txt', size: 10 },
      ],
    }),
    uploadFile: async (_nodeId, _serverId, path) => { uploads.push(path); return { success: true }; },
    deleteFileOrDirectory: async (_nodeId, _serverId, path) => { deleted.push(path); return { success: true }; },
    extractArchive: async () => ({ success: true }),
    installModpack: async (_nodeId, _serverId, path) => ({ success: true, path }),
  };
  const versions = {
    descriptor: () => ({
      eggId: 'fabric',
      name: 'Fabric',
      gameId: 'minecraft',
      kind: 'mod-loader',
      provider: 'fabric',
      currentVersion: '1.21.1',
    }),
  };
  const settings = { curseForgeApiKey: () => '' };
  const service = new MinecraftModsService(client, versions, settings);
  service.requestJson = async url => {
    assert.match(url, /api\.modrinth\.com\/v2\/search/);
    return {
      total_hits: 1,
      hits: [{
        project_id: 'fabric-api',
        slug: 'fabric-api',
        project_type: 'mod',
        title: 'Fabric API',
        description: 'Core hooks',
        author: 'FabricMC',
        downloads: 100,
        versions: ['1.21.1'],
        categories: ['fabric', 'utility'],
      }],
    };
  };

  const server = { id: 'server-1', nodeId: 'node-1', eggId: 'fabric', status: 'stopped', variables: {} };
  const catalog = await service.search(server, {
    projectType: 'mod',
    provider: 'modrinth',
    page: 2,
    pageSize: 20,
    gameVersion: '1.21.1',
    loader: 'fabric',
    query: 'api',
  });
  assert.equal(catalog.items[0].title, 'Fabric API');
  assert.deepEqual(catalog.items[0].loaders, ['fabric']);
  assert.equal(catalog.profile.gameVersion, '1.21.1');

  const installed = await service.installed(server);
  assert.deepEqual(installed.items.map(item => item.name), ['disabled-mod.jar.disabled', 'fabric-api.jar']);
  assert.equal(installed.items[0].enabled, false);

  await assert.rejects(() => service.remove(server, '/mods/../server.jar'), /only installed mod files/);
  await service.remove(server, 'fabric-api.jar');
  assert.deepEqual(deleted, ['/mods/fabric-api.jar']);

  const running = { ...server, status: 'running' };
  await assert.rejects(
    () => service.install(running, { provider: 'modrinth', projectId: 'pack', projectType: 'modpack' }),
    /stop the Minecraft server/,
  );

  service.resolveModrinth = async () => ({
    provider: 'modrinth',
    projectType: 'modpack',
    projectId: 'pack',
    versionId: 'version-1',
    title: 'Example Pack',
    fileName: 'example.mrpack',
    url: 'https://cdn.modrinth.com/data/example/versions/1/example.mrpack',
  });
  service.download = async function* () { yield Buffer.from('PK\x03\x04'); };
  const pack = await service.install(server, {
    provider: 'modrinth',
    projectId: 'pack',
    projectType: 'modpack',
  });
  assert.equal(pack.fileName, 'example.mrpack');
  assert.deepEqual(uploads, ['/.agapornis/modpacks/example.mrpack']);
  assert.ok(deleted.includes('/.agapornis/modpacks/example.mrpack'));

  assert.throws(() => service.trustedApiUrl('https://127.0.0.1/catalog'), /not trusted/);
  assert.throws(() => service.trustedDownloadUrl('https://example.com/mod.jar'), /not trusted/);
  console.log('Minecraft mod catalog, installed inventory, and safety checks: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
