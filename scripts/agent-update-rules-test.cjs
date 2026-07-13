require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { BadRequestException } = require('@nestjs/common');
const { AgentUpdateService } = require('../src/modules/agents/agent-update.service');
const { ApiConfigService } = require('../src/common/config/config.service');

async function main() {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousUrl = process.env.AGAPORNIS_AGENT_UPDATE_URL;
  const previousSha = process.env.AGAPORNIS_AGENT_UPDATE_SHA256;

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.AGAPORNIS_AGENT_UPDATE_URL;
    delete process.env.AGAPORNIS_AGENT_UPDATE_SHA256;

    const calls = [];
    const service = new AgentUpdateService(
      { list: () => [{ nodeId: 'node-1' }] },
      {
        getUpdateStatus: async () => ({ runtimeIdentifier: 'linux-x86_64' }),
        applyUpdate: async (nodeId, payload) => {
          calls.push({ nodeId, payload });
          return { accepted: true, nodeId, payload };
        },
      },
      {
        agentRelease: async () => ({ version: '2.0.0', artifacts: { 'linux-x86_64': {} } }),
        compareReleaseVersions: () => 1,
        agentArtifact: async () => ({ url: 'https://updates.example/agent', sha256: 'a'.repeat(64) }),
      },
      new ApiConfigService(),
    );

    const status = await service.status();
    assert.equal(status.latestVersion, '2.0.0');
    assert.equal(status.agents[0].updateAvailable, true);

    await assert.rejects(
      () => service.apply('node-1', { artifactUrl: 'http://updates.example/agent', sha256: 'a'.repeat(64) }),
      BadRequestException,
    );
    await assert.rejects(
      () => service.apply('node-1', { artifactUrl: 'https://updates.example/agent', sha256: 'bad' }),
      BadRequestException,
    );

    const result = await service.apply('node-1', {});
    assert.equal(result.accepted, true);
    assert.equal(calls[0].payload.sha256, 'a'.repeat(64));

    console.log('agent update validation tests: PASS');
  } finally {
    restore('NODE_ENV', previousNodeEnv);
    restore('AGAPORNIS_AGENT_UPDATE_URL', previousUrl);
    restore('AGAPORNIS_AGENT_UPDATE_SHA256', previousSha);
  }
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
