const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const {
  dockerImageOptions,
  interpolate,
  resolveConfigFiles,
  resolveDockerImage,
} = require('../src/modules/eggs/egg-resolver.ts');
const { EggsService } = require('../src/modules/eggs/eggs.service.ts');

const env = {
  SERVER_PORT: '25565',
  SERVER_ID: 'server-one',
  DOCKER_INTERFACE: '172.18.0.1',
};

const resolved = resolveConfigFiles({
  'config.yml': {
    parser: 'yaml',
    find: {
      'listeners[0].query_enabled': true,
      'listeners[0].query_port': '{{server.build.default.port}}',
      'servers.*.address': {
        '127.0.0.1': '{{env.DOCKER_INTERFACE}}',
        localhost: '{{env.DOCKER_INTERFACE}}',
      },
    },
  },
}, env);

assert.equal(resolved['config.yml'].find['listeners[0].query_enabled'], true);
assert.equal(resolved['config.yml'].find['listeners[0].query_port'], '25565');
assert.deepEqual(resolved['config.yml'].find['servers.*.address'], {
  '127.0.0.1': '172.18.0.1',
  localhost: '172.18.0.1',
});
assert.equal(interpolate('{{server.uuid}}', env), 'server-one');
assert.equal(
  interpolate('{{config.docker.interface}}', env),
  '{{config.docker.interface}}',
);

const service = new EggsService();
const egg = service.normalize({
  name: 'Lifecycle Test',
  images: ['example/server:latest'],
  startup: './server',
  config: {
    stop: '^C',
    startup: JSON.stringify({ done: 'Server started' }),
    files: {},
  },
});
assert.equal(egg.stopCommand, '^C');
assert.equal(egg.startupDone, 'Server started');

const javaEgg = {
  images: [],
  dockerImages: [
    { label: 'Java 17', image: 'ghcr.io/example/yolk:java_17' },
    { label: 'Java 25', image: 'ghcr.io/example/yolk:java_25' },
    { label: 'Java 21', image: 'ghcr.io/example/yolk:java_21' },
  ],
};
assert.deepEqual(
  dockerImageOptions(javaEgg).map(option => option.label),
  ['Java 25', 'Java 21', 'Java 17'],
);
assert.equal(resolveDockerImage(javaEgg), 'ghcr.io/example/yolk:java_25');
assert.equal(
  resolveDockerImage(javaEgg, 'Java 17'),
  'ghcr.io/example/yolk:java_17',
);

console.log('Egg configuration self-test passed.');
