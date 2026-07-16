const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { EggsService } = require('../src/modules/eggs/eggs.service.ts');
const { EGG_CATALOG } = require('../src/modules/eggs/egg-catalog.ts');

assert.equal(EGG_CATALOG.length, 10, 'the starter catalog should include ten maintained eggs');
assert.equal(new Set(EGG_CATALOG.map(item => item.id)).size, EGG_CATALOG.length, 'catalog ids must be unique');
assert.equal(new Set(EGG_CATALOG.map(item => item.eggId)).size, EGG_CATALOG.length, 'installed egg ids must be unique');
for (const item of EGG_CATALOG) {
  assert.match(item.sourceUrl, /^https:\/\/raw\.githubusercontent\.com\/pterodactyl\/game-eggs\/main\//);
}

const service = new EggsService();
let saveCalls = 0;
service.save = () => { saveCalls += 1; };

const egg = name => ({
  meta: { name },
  images: ['example/server:latest'],
  startup: './server'
});

const garrysMod = service.normalize(egg('Garrys Mod'));
service.eggs.set(garrysMod.id, garrysMod);
assert.equal(garrysMod.id, 'garrys-mod');
assert.equal(
  service.catalog().find(item => item.id === 'garrys-mod').installed,
  true,
  'the Garrys Mod catalog entry must recognize the normalized upstream egg id'
);

const imported = service.importMany([egg('Batch Test One'), egg('Batch Test Two')]);
assert.equal(imported.length, 2);
assert.equal(saveCalls, 1, 'a valid batch should be persisted once');

assert.throws(
  () => service.importMany([egg('Duplicate Egg'), egg('Duplicate Egg')]),
  /duplicate id/
);
assert.equal(saveCalls, 1, 'an invalid batch must not be persisted');

console.log('Egg batch self-test passed: two eggs imported with one atomic save.');
