require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SystemUpdateService } = require('../src/modules/system-updates/system-update.service');

const apiArtifact = Buffer.from('verified api artifact');
const frontendArtifact = Buffer.from('verified frontend artifact');
const agentArtifact = Buffer.from('verified agent artifact');
const checksum = value => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agapornis-panel-update-'));
  const manualRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agapornis-panel-update-manual-'));
  const variables = [
    'NODE_ENV', 'AGAPORNIS_PANEL_UPDATE_DIR', 'AGAPORNIS_PANEL_UPDATE_COMMAND',
    'AGAPORNIS_PANEL_UPDATE_ARGS', 'AGAPORNIS_PANEL_UPDATE_COMMAND_CWD',
    'AGAPORNIS_PANEL_UPDATE_COMPONENTS',
    'AGAPORNIS_API_VERSION', 'AGAPORNIS_FRONTEND_VERSION',
    'AGAPORNIS_API_RELEASE_MANIFEST_URL', 'AGAPORNIS_FRONTEND_RELEASE_MANIFEST_URL',
    'AGAPORNIS_AGENT_RELEASE_MANIFEST_URL',
  ];
  const previous = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  const server = http.createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/api-artifact') return send(response, apiArtifact);
    if (request.url === '/frontend-artifact') return send(response, frontendArtifact);
    if (request.url === '/agent-artifact') return send(response, agentArtifact);
    if (request.url === '/api-manifest') return manifest(response, 'api', '2.0.0', {
      artifact: artifact(`${origin}/api-artifact`, apiArtifact),
    });
    if (request.url === '/frontend-manifest') return manifest(response, 'frontend', '3.0.0', {
      artifact: artifact(`${origin}/frontend-artifact`, frontendArtifact),
    });
    if (request.url === '/agent-manifest') return manifest(response, 'agent', '4.0.0', {
      artifacts: { 'linux-x86_64': artifact(`${origin}/agent-artifact`, agentArtifact) },
    });
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    process.env.NODE_ENV = 'test';
    process.env.AGAPORNIS_PANEL_UPDATE_DIR = root;
    process.env.AGAPORNIS_PANEL_UPDATE_COMMAND = process.execPath;
    process.env.AGAPORNIS_PANEL_UPDATE_ARGS = '["-e",""]';
    process.env.AGAPORNIS_PANEL_UPDATE_COMMAND_CWD = process.cwd();
    process.env.AGAPORNIS_PANEL_UPDATE_COMPONENTS = 'api,frontend';
    process.env.AGAPORNIS_API_VERSION = '1.0.0';
    delete process.env.AGAPORNIS_FRONTEND_VERSION;
    process.env.AGAPORNIS_API_RELEASE_MANIFEST_URL = `${origin}/api-manifest`;
    process.env.AGAPORNIS_FRONTEND_RELEASE_MANIFEST_URL = `${origin}/frontend-manifest`;
    process.env.AGAPORNIS_AGENT_RELEASE_MANIFEST_URL = `${origin}/agent-manifest`;

    const documents = { enabled: false, replaceCollection: async () => undefined };
    const redis = { withLock: async (_name, _ttl, task) => ({ acquired: true, result: await task() }) };
    const service = new SystemUpdateService(documents, redis);
    await service.onModuleInit();

    const status = await service.status(true, '1.5.0');
    assert.equal(status.updateAvailable, true);
    assert.equal(status.components.api.latestVersion, '2.0.0');
    assert.equal(status.components.frontend.latestVersion, '3.0.0');
    assert.equal(status.current.frontend, '1.5.0');
    assert.deepEqual(status.managedComponents, ['api', 'frontend']);
    assert.equal(status.deployableUpdateAvailable, true);
    assert.equal((await service.agentArtifact('linux-x86_64')).sha256, checksum(agentArtifact));

    const deployed = await service.deploy('1.5.0');
    assert.equal(deployed.state.status, 'applying');
    assert.deepEqual(deployed.state.targetVersions, { api: '2.0.0', frontend: '3.0.0' });
    const staged = deployed.state.artifacts;
    assert.equal(fs.readFileSync(staged.find(item => item.component === 'api').path).toString(), apiArtifact.toString());
    assert.equal(fs.readFileSync(staged.find(item => item.component === 'frontend').path).toString(), frontendArtifact.toString());
    const job = JSON.parse(fs.readFileSync(path.join(root, 'current-job.json'), 'utf8'));
    assert.equal(job.updates.api.version, '2.0.0');
    assert.equal(job.updates.frontend.version, '3.0.0');
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({
      status: 'completed',
      completedAt: new Date().toISOString(),
      targetVersions: { api: '2.0.0', frontend: '3.0.0' },
    }));
    assert.equal((await service.status(false, '3.0.0')).state.status, 'completed');

    process.env.AGAPORNIS_PANEL_UPDATE_DIR = manualRoot;
    delete process.env.AGAPORNIS_PANEL_UPDATE_COMMAND;
    delete process.env.AGAPORNIS_PANEL_UPDATE_ARGS;
    process.env.AGAPORNIS_PANEL_UPDATE_COMPONENTS = 'api';
    process.env.AGAPORNIS_API_VERSION = '1.0.0';
    const manualService = new SystemUpdateService(documents, redis);
    await manualService.onModuleInit();
    const manualStatus = await manualService.status(true, '1.5.0');
    assert.equal(manualStatus.deployCommandConfigured, false);
    assert.deepEqual(manualStatus.managedComponents, ['api']);
    assert.equal(manualStatus.components.frontend.managed, false);
    const manual = await manualService.deploy('1.5.0');
    assert.equal(manual.state.status, 'staged');
    assert.equal(manual.state.manualApplyRequired, true);
    assert.match(manual.state.errorMessage, /must be applied manually/);
    assert.equal(fs.existsSync(path.join(manualRoot, 'current-job.json')), true);
    const manualJob = JSON.parse(fs.readFileSync(path.join(manualRoot, 'current-job.json'), 'utf8'));
    assert.equal(manualJob.updates.api.version, '2.0.0');
    assert.equal(manualJob.updates.frontend, undefined);
    console.log('separate release manifests, managed components, checksums, staging, and native job test: PASS');
  } finally {
    server.close();
    await new Promise(resolve => setTimeout(resolve, 900));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(manualRoot, { recursive: true, force: true });
    for (const name of variables) restore(name, previous[name]);
  }
}

function artifact(url, body) {
  return { url, sha256: checksum(body), sizeBytes: body.length };
}

function manifest(response, component, version, fields) {
  return send(response, Buffer.from(JSON.stringify({
    schemaVersion: 1,
    component,
    version,
    channel: 'test',
    releaseNotes: `${component} regression fixture`,
    ...fields,
  })), 'application/json');
}

function send(response, body, contentType = 'application/octet-stream') {
  response.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
  response.end(body);
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
