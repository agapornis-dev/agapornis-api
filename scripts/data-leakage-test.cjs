const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { ServerRegistryService } = require('../src/modules/servers/services/server-registry.service.ts');
const { UsersService } = require('../src/modules/users/users.service.ts');
const { WebhooksService } = require('../src/modules/webhooks/webhooks.service.ts');
const { WebhooksController } = require('../src/modules/webhooks/webhooks.controller.ts');
const { ServerFilesController } = require('../src/modules/servers/controllers/server-files.controller.ts');
const { ServerRuntimeController } = require('../src/modules/servers/controllers/server-runtime.controller.ts');
const { ServerCollaboratorsController } = require('../src/modules/servers/controllers/server-collaborators.controller.ts');
const { ServerRegistryController } = require('../src/modules/servers/controllers/server-registry.controller.ts');
const { ServerDatabasesController } = require('../src/modules/servers/controllers/server-databases.controller.ts');
const { ProvisioningJobsService } = require('../src/modules/servers/services/provisioning-jobs.service.ts');
const { ActivityLogService } = require('../src/modules/activity-log/activity-log.service.ts');

async function main() {
  const registry = Object.create(ServerRegistryService.prototype);
  registry.eggs = {
    userEditableVariableKeys: () => new Set(['PUBLIC_SETTING']),
    get: () => ({ startup: 'default {{SERVER_PORT}}' }),
    resolveServer: () => ({ startup_command: 'default 25565' }),
  };
  const server = {
    id: 'server-1',
    nodeId: 'node-1',
    name: 'Private server',
    eggId: 'minecraft',
    ownerUserId: 'owner-1',
    status: 'running',
    variables: {
      PUBLIC_SETTING: 'visible-with-settings-access',
      INTERNAL_SETTING: 'owner-visible-only',
      SERVER_MEMORY: '2048',
      SERVER_DISK: '10240',
      SERVER_CPU: '100',
      SERVER_ID: 'server-1',
      STARTUP: 'wine ./Game.exe --port "25565"',
      AGAPORNIS_STARTUP_TEMPLATE: 'wine ./Game.exe --port "{{SERVER_PORT}}"',
      AGAPORNIS_FROZEN: 'true',
      AGAPORNIS_FREEZE_REASON: 'private billing note',
      AGAPORNIS_PORT_MAPPINGS: '[]',
    },
    collaborators: [
      { userId: 'reader-1', permission: 'read_only', permissions: ['console.view', 'files.view'] },
      { userId: 'settings-1', permission: 'custom', permissions: ['settings'] },
    ],
    collaboratorUserIds: ['reader-1', 'settings-1'],
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const readerView = registry.forUser(server, { id: 'reader-1', role: 'user' });
  assert.equal(readerView.variables, undefined);
  assert.equal(readerView.ownerUserId, undefined);
  assert.equal(readerView.collaborators, undefined);
  assert.equal(readerView.collaboratorUserIds, undefined);
  assert.equal(readerView.access.relationship, 'collaborator');
  assert.equal(readerView.access.canManageAccess, undefined);

  const settingsView = registry.forUser(server, { id: 'settings-1', role: 'user' });
  assert.equal(settingsView.variables.PUBLIC_SETTING, 'visible-with-settings-access');
  assert.equal(settingsView.variables.INTERNAL_SETTING, undefined);
  assert.equal(settingsView.variables.AGAPORNIS_FROZEN, undefined);
  assert.equal(settingsView.variables.AGAPORNIS_FREEZE_REASON, undefined);
  assert.equal(settingsView.variables.AGAPORNIS_PORT_MAPPINGS, undefined);
  assert.equal(settingsView.variables.SERVER_MEMORY, undefined);
  assert.equal(settingsView.variables.SERVER_DISK, undefined);
  assert.equal(settingsView.variables.SERVER_CPU, undefined);
  assert.equal(settingsView.variables.SERVER_ID, undefined);
  assert.equal(settingsView.startupCommand, 'wine ./Game.exe --port "25565"');
  assert.equal(settingsView.startupTemplate, undefined);

  const ownerView = registry.forUser(server, { id: 'owner-1', role: 'user' });
  assert.equal(ownerView.access, undefined);
  assert.equal(ownerView.ownerUserId, undefined);
  assert.equal(ownerView.variables.AGAPORNIS_PORT_MAPPINGS, undefined);
  assert.equal(ownerView.variables.INTERNAL_SETTING, 'owner-visible-only');
  assert.equal(ownerView.startupCommand, 'wine ./Game.exe --port "25565"');
  assert.equal(ownerView.startupTemplate, undefined);

  const adminView = registry.forUser(server, { id: 'admin-1', role: 'admin' });
  assert.equal(adminView.variables.AGAPORNIS_PORT_MAPPINGS, '[]');
  assert.equal(adminView.variables.SERVER_MEMORY, undefined, 'resource controls must not leak back into the Variables tab contract');
  assert.equal(adminView.startupCommand, 'wine ./Game.exe --port "25565"');
  assert.equal(adminView.startupTemplate, 'wine ./Game.exe --port "{{SERVER_PORT}}"');

  const supportView = registry.forUser(server, { id: 'support-1', role: 'support' });
  assert.equal(supportView.variables, undefined);
  assert.equal(supportView.ownerUserId, undefined);

  const accessQueries = [];
  const accessIndexRegistry = Object.create(ServerRegistryService.prototype);
  accessIndexRegistry.database = {
    enabled: true,
    placeholders: count => Array.from({ length: count }, () => '?').join(', '),
    query: async sql => {
      accessQueries.push(sql);
      return [];
    },
  };
  await accessIndexRegistry.listAccessIndex();
  assert.doesNotMatch(accessQueries[0], /SELECT \*/i);
  assert.doesNotMatch(accessQueries[0], /variables|database_/i);

  const users = Object.create(UsersService.prototype);
  const userRecord = {
    id: 'user-1',
    email: 'user@example.com',
    name: 'User',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    sessionVersion: 42,
    twoFactor: { enabled: true, recoveryCodeHashes: ['a', 'b'] },
    authProviders: [],
  };
  assert.equal(users.publicUser(userRecord).sessionVersion, undefined);
  assert.equal(users.adminUser(userRecord).recoveryCodesRemaining, undefined);

  const permissionChecks = [];
  const nodeAccessChecks = [];
  const routeSupport = {
    queryPath: (_path, _target, fallback) => fallback,
    requireNodeServerPermission: async (...args) => permissionChecks.push(args),
    requireNodeServerAccess: async (...args) => {
      nodeAccessChecks.push(args);
      return server;
    },
    forward: async () => ({ success: true }),
  };
  const filesController = new ServerFilesController({}, routeSupport);
  await filesController.listDirectory('node-1', 'server-1', undefined, undefined, { user: userRecord });
  const runtimeController = new ServerRuntimeController(
    { getServerStats: async () => ({}) },
    {},
    routeSupport,
    {},
  );
  await runtimeController.getStats('node-1', 'server-1', { user: userRecord });
  assert.deepEqual(permissionChecks[0].slice(0, 3), ['node-1', 'server-1', userRecord]);
  assert.equal(permissionChecks[0][3], 'files.view');
  assert.deepEqual(nodeAccessChecks[0], ['node-1', 'server-1', userRecord]);

  const collaboratorController = new ServerCollaboratorsController(
    { canManageAccess: () => false },
    {},
    {},
    { requireNotSupport: () => undefined, requireNodeServerAccess: async () => server },
    {},
  );
  await assert.rejects(
    collaboratorController.list('node-1', 'server-1', { user: userRecord }),
    /only the server owner or an administrator/,
  );

  const availableEggsController = new ServerRegistryController(
    {
      listInternal: async () => [{ ...server, eggId: 'visible-egg', eggChangeAllowed: undefined }],
      canAccess: () => true,
      canPerform: () => false,
    },
    {},
    {},
    {
      list: () => [{ id: 'visible-egg' }, { id: 'hidden-egg' }],
      clientEgg: (id, _role, includeVariables) => ({ id, variables: includeVariables ? ['private'] : [] }),
    },
    {},
    {},
    {},
    {},
    {},
    {},
  );
  assert.deepEqual(
    await availableEggsController.availableEggs({ user: { id: 'reader-1', role: 'user' } }),
    [{ id: 'visible-egg', variables: [] }],
  );

  const webhooks = Object.create(WebhooksService.prototype);
  const targetSummary = webhooks.targetSummary({
    id: 'hook-1',
    name: 'Discord',
    scope: 'server',
    serverId: 'server-1',
    ownerUserId: 'owner-1',
    provider: 'discord',
    url: 'https://discord.example/api/webhooks/id/secret?token=also-secret',
    chatId: 'private-chat',
    secret: 'signing-secret',
    enabled: true,
    events: ['server.up'],
    headers: { authorization: 'Bearer private' },
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(targetSummary.url, 'https://discord.example/…');
  assert.equal(targetSummary.secret, undefined);
  assert.equal(targetSummary.headers, undefined);
  assert.equal(targetSummary.ownerUserId, undefined);
  assert.equal(targetSummary.chatId, undefined);
  assert.equal(targetSummary.secretConfigured, true);
  assert.equal(targetSummary.customHeadersConfigured, true);

  const activity = Object.create(ActivityLogService.prototype);
  activity.database = { enabled: false };
  activity.users = { findById: () => ({ name: 'Server owner' }) };
  activity.entries = [{
    id: 'activity-1',
    event: 'server.command',
    userId: 'owner-1',
    userEmail: 'owner@example.com',
    serverId: 'server-1',
    nodeId: 'node-1',
    meta: { command: 'op secret-user' },
    ip: '192.0.2.10',
    createdAt: '2026-01-01T00:00:00.000Z',
  }];
  const [serverActivity] = await activity.forServer('server-1');
  assert.equal(serverActivity.userId, undefined);
  assert.equal(serverActivity.userEmail, undefined);
  assert.equal(serverActivity.serverId, undefined);
  assert.equal(serverActivity.nodeId, undefined);
  assert.equal(serverActivity.meta, undefined);
  assert.equal(serverActivity.ip, undefined);

  const databasesController = new ServerDatabasesController(
    {
      listServerDatabases: async () => [{
        id: 'database-1',
        containerId: 'internal-container-id',
        type: 'postgres',
        name: 'Main database',
        databaseName: 'main',
        username: 'server_user',
        password: 'owner-visible-password',
        host: 'db.example.test',
        port: 5432,
        dockerImage: 'private.registry/postgres:latest',
        memoryBytes: 1024,
        diskLimitBytes: 2048,
        cpuLimitPercentage: 50,
        cpuCores: 1,
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
      getServerDatabase: async () => ({
        id: 'database-1',
        databaseName: 'main',
        username: 'server_user',
        password: 'owner-visible-password',
        host: 'db.example.test',
        port: 5432,
      }),
    },
    {
      get: async () => server,
      canAccess: () => true,
      canPerform: () => true,
    },
    {
      requireNotSupport: () => undefined,
      requireNotFrozen: () => undefined,
    },
  );
  const [databaseView] = await databasesController.listServerDatabases('server-1', { user: userRecord });
  assert.equal(databaseView.containerId, undefined);
  assert.equal(databaseView.dockerImage, undefined);
  assert.equal(databaseView.memoryBytes, undefined);
  assert.equal(databaseView.diskLimitBytes, undefined);
  assert.equal(databaseView.password, undefined);
  assert.equal(databaseView.passwordConfigured, true);
  await assert.rejects(
    databasesController.revealServerDatabaseCredentials('server-1', 'database-1', { user: userRecord }),
    /only the server owner or a panel administrator/,
  );
  const databaseCredentials = await databasesController.revealServerDatabaseCredentials(
    'server-1',
    'database-1',
    { user: { ...userRecord, id: 'owner-1' } },
  );
  assert.equal(databaseCredentials.password, 'owner-visible-password');

  const webhookAddressChecks = Object.create(WebhooksService.prototype);
  for (const address of ['127.0.0.1', '::ffff:7f00:1', '192.0.2.10', '198.51.100.5', '203.0.113.8', 'ff02::1']) {
    assert.equal(webhookAddressChecks.isPrivateAddress(address), true, `${address} was not blocked`);
  }
  assert.deepEqual(
    webhookAddressChecks.safeHeaders({ Host: 'internal', 'transfer-encoding': 'chunked', authorization: 'allowed' }),
    { authorization: 'allowed' },
  );

  let summaryQuery = '';
  const databaseWebhooks = Object.create(WebhooksService.prototype);
  databaseWebhooks.database = {
    enabled: true,
    placeholders: () => '?',
    query: async sql => {
      summaryQuery = sql;
      return [];
    },
  };
  await databaseWebhooks.listTargetSummariesFor({ scope: 'admin' });
  assert.doesNotMatch(summaryQuery, /SELECT \*/i);

  const jobs = new ProvisioningJobsService({
    setJson: async () => undefined,
    publish: async () => undefined,
  });
  const publicJob = jobs.start(
    { id: 'admin-private-id' },
    { serverId: 'server-1' },
    async () => ({ success: true }),
  );
  assert.equal(publicJob.requestedBy, undefined);

  const previousSecret = process.env.INCOMING_WEBHOOK_SECRET;
  process.env.INCOMING_WEBHOOK_SECRET = 'incoming-test-secret';
  const controller = new WebhooksController({
    dispatch: async () => ({
      eventType: 'external.event',
      delivered: 1,
      results: [{ responseBody: 'downstream private data' }],
    }),
  }, {
    get: name => process.env[name] || '',
  });
  try {
    await assert.rejects(
      controller.handleIncoming('external.event', {}, { 'x-agapornis-secret': 'wrong' }),
      /invalid webhook secret/,
    );
    const result = await controller.handleIncoming(
      'external.event',
      {},
      { 'x-agapornis-secret': 'incoming-test-secret' },
    );
    assert.deepEqual(result, { eventType: 'external.event', delivered: 1 });
  } finally {
    if (previousSecret === undefined) delete process.env.INCOMING_WEBHOOK_SECRET;
    else process.env.INCOMING_WEBHOOK_SECRET = previousSecret;
  }

  console.log('API data-leakage regression test: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
