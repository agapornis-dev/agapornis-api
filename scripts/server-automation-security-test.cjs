const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { ServerRegistryService } = require('../src/modules/servers/services/server-registry.service.ts');
const { ServerSchedulesService } = require('../src/modules/servers/services/server-schedules.service.ts');
const { ServerSchedulesController } = require('../src/modules/servers/controllers/server-schedules.controller.ts');
const { ServerBackupOperationsService } = require('../src/modules/servers/services/server-backup-operations.service.ts');
const { ServerWebhooksController } = require('../src/modules/servers/controllers/server-webhooks.controller.ts');
const { WebhooksService } = require('../src/modules/webhooks/webhooks.service.ts');

async function main() {
  const registry = Object.create(ServerRegistryService.prototype);
  const sharedServer = {
    id: 'server-1',
    nodeId: 'node-1',
    ownerUserId: 'owner-1',
    status: 'running',
    collaborators: [{ userId: 'collaborator-1', permission: 'custom', permissions: ['schedules'] }],
  };
  const collaborator = { id: 'collaborator-1', role: 'user' };
  assert.equal(registry.canPerform(sharedServer, collaborator, 'schedules'), true);
  assert.equal(registry.canPerform(sharedServer, collaborator, 'webhooks'), false);
  sharedServer.collaborators[0].permissions.push('webhooks');
  assert.equal(registry.canPerform(sharedServer, collaborator, 'webhooks'), true);

  const scheduleController = new ServerSchedulesController(
    {
      listForServer: () => [
        { id: 'command-task', name: 'Private command', action: 'command' },
        { id: 'backup-task', name: 'Visible backup', action: 'backup_create' },
      ],
      requiredPermission: action => action === 'command' ? 'console.send' : 'backups',
    },
    {},
    {
      requireNotSupport: () => undefined,
      requireNodeServerPermission: async () => sharedServer,
    },
    { canPerform: (_server, _user, scope) => scope === 'backups' },
  );
  const visibleSchedules = await scheduleController.listSchedules('node-1', 'server-1', { user: collaborator });
  assert.deepEqual(visibleSchedules.map(schedule => schedule.id), ['backup-task']);

  const observedScopes = [];
  const webhookController = new ServerWebhooksController(
    {
      listTargetSummariesFor: async () => [],
      createTarget: async body => ({ id: 'hook-1', ...body, createdAt: new Date().toISOString(), headers: {} }),
      targetSummary: target => target,
      dispatch: async () => ({ eventType: 'server.webhook.test', delivered: 1 }),
      deleteTargetFor: async id => ({ id, deleted: true }),
    },
    {
      requireNotSupport: () => undefined,
      requireNodeServerPermission: async (_nodeId, _serverId, _user, scope) => {
        observedScopes.push(scope);
        return { ...sharedServer, name: 'Server', variables: {} };
      },
    },
  );
  const request = { user: collaborator };
  await webhookController.listServerWebhooks('node-1', 'server-1', request);
  await webhookController.createServerWebhook('node-1', 'server-1', {
    name: 'Status', provider: 'generic', url: 'https://hooks.example.test/', events: ['server.started'],
  }, request);
  await webhookController.testServerWebhook('node-1', 'server-1', 'hook-1', request);
  await webhookController.deleteServerWebhook('node-1', 'server-1', 'hook-1', request);
  assert.deepEqual(observedScopes, ['webhooks', 'webhooks', 'webhooks', 'webhooks']);
  await assert.rejects(
    webhookController.createServerWebhook('node-1', 'server-1', {
      name: 'Invalid', provider: 'generic', url: 'https://hooks.example.test/', events: ['billing.server.provisioned'],
    }, request),
    /valid server webhook event/,
  );

  const webhooks = Object.create(WebhooksService.prototype);
  webhooks.database = { enabled: false };
  webhooks.targets = new Map();
  webhooks.saveTargets = () => undefined;
  webhooks.assertPublicWebhookTarget = async () => undefined;
  await assert.rejects(webhooks.safeUrl('https://hooks.example.test:8443/path'), /port 80 or 443/);
  webhooks.safeUrl = async value => String(value);
  await assert.rejects(
    webhooks.createTarget({ name: 'Hook', url: 'https://hooks.example.test', headers: { 'X-Test': 'ok\r\nHost: internal' } }),
    /invalid value/,
  );
  await assert.rejects(
    webhooks.createTarget({ name: 'Bad\nName', url: 'https://hooks.example.test' }),
    /invalid characters/,
  );
  await assert.rejects(
    webhooks.createTarget({ name: 'Hook', url: 'https://hooks.example.test', events: ['<script>'] }),
    /invalid event name/,
  );
  const discordBody = webhooks.messageBody({ provider: 'discord' }, 'server.started', { serverName: '@everyone' });
  assert.deepEqual(discordBody.allowed_mentions, { parse: [] });

  const schedules = Object.create(ServerSchedulesService.prototype);
  schedules.schedules = new Map();
  schedules.timers = new Map();
  schedules.executions = new Map();
  schedules.logger = { log: () => undefined, error: () => undefined };
  schedules.database = { enabled: false };
  schedules.save = () => undefined;
  schedules.schedule = () => undefined;
  assert.equal(schedules.requiredPermission('backup_create'), 'backups');
  assert.equal(schedules.requiredPermission('clear_directory'), 'files.write');
  assert.throws(() => schedules.targetPath('/'), /non-root/);
  assert.throws(() => schedules.targetPath('../secrets'), /unsafe path segment/);
  assert.throws(
    () => schedules.create('server-1', 'node-1', { name: 'Too frequent', action: 'clear_directory', targetPath: 'logs', intervalSeconds: 60 }, collaborator),
    /between 300/,
  );
  const clearSchedule = schedules.create('server-1', 'node-1', {
    name: 'Clear logs', action: 'clear_directory', targetPath: '/logs/archive/', intervalSeconds: 300,
  }, collaborator);
  assert.equal(clearSchedule.targetPath, 'logs/archive');
  assert.equal(clearSchedule.actorUserId, collaborator.id);

  let backupCreates = 0;
  let permissionGranted = false;
  schedules.registry = {
    get: async () => ({ ...sharedServer, backupLimit: 3 }),
    isFrozen: () => false,
    canPerform: (_server, _user, scope) => permissionGranted && ['schedules', 'backups'].includes(scope),
  };
  schedules.users = { findByIdForAuth: async () => ({ id: collaborator.id, role: 'user', email: 'user@example.test' }) };
  schedules.backups = { create: async () => { backupCreates += 1; return { success: true }; } };
  schedules.activityLog = { log: () => undefined };
  const backupSchedule = {
    id: 'backup-schedule', serverId: 'server-1', nodeId: 'node-1', name: 'Backup', enabled: true,
    intervalSeconds: 3600, action: 'backup_create', storage: 'local', actorUserId: collaborator.id,
  };
  await assert.rejects(schedules.execute(backupSchedule), /no longer has schedules and backups permission/);
  assert.equal(backupCreates, 0);
  permissionGranted = true;
  await schedules.execute(backupSchedule);
  assert.equal(backupCreates, 1);

  let deletedPaths = [];
  schedules.client = {
    listDirectory: async () => ({ items: [{ name: '../escape' }] }),
    deleteFileOrDirectory: async (_node, _server, targetPath) => { deletedPaths.push(targetPath); return { success: true }; },
  };
  await assert.rejects(schedules.clearDirectory('node-1', 'server-1', 'logs'), /unsafe directory entry/);
  assert.deepEqual(deletedPaths, []);
  schedules.client.listDirectory = async () => ({ items: [{ name: 'old.log' }, { name: 'archive' }] });
  await schedules.clearDirectory('node-1', 'server-1', 'logs');
  assert.deepEqual(deletedPaths, ['logs/old.log', 'logs/archive']);

  const backupOperations = Object.create(ServerBackupOperationsService.prototype);
  backupOperations.list = async () => [
    { backupId: 'new-backup', storage: 'local', createdAt: '2026-02-01T00:00:00.000Z' },
    { backupId: 'old-backup', storage: 'local', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  let deletedBackup;
  backupOperations.delete = async (_server, backupId) => { deletedBackup = backupId; return { success: true }; };
  await backupOperations.deleteOldest(sharedServer, 'local');
  assert.equal(deletedBackup, 'old-backup');

  console.log('server automation security tests: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
