require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { BillingProvisioningController } = require('../src/modules/servers/controllers/billing-provisioning.controller');
const { UsersService } = require('../src/modules/users/users.service');

async function main() {
  const previousSecret = process.env.BILLING_WEBHOOK_SECRET;
  process.env.BILLING_WEBHOOK_SECRET = 'webhook-test-secret';

  const users = Object.create(UsersService.prototype);
  users.users = new Map();
  users.repository = { enabled: true, replace: async () => undefined };
  users.config = { positiveInt: (_name, fallback) => fallback };

  const plan = {
    id: 'minecraft-basic', name: 'Minecraft Basic', enabled: true, externalIds: ['42'],
    eggId: 'minecraft', eggChangeAllowed: false, allowedEggIds: ['minecraft'],
    location: 'de-fra', nodeId: 'node-a', memoryMb: 1024, diskMb: 4096,
    cpuLimitPercentage: 150, cpuPinnedThreads: '1,3-4', swapMemoryMb: 256, swapMemoryStorage: 'server', variables: { SERVER_PORT: '25565' },
    databasesEnabled: false, databaseLimit: 0, backupLimit: 0,
  };
  const node = { nodeId: 'node-a', location: 'de-fra', portRangeStart: 30000, portRangeEnd: 30010 };
  let reservation;
  let createRequest;
  let dispatched;
  let requestedPortCount;

  const controller = new BillingProvisioningController(
    { deleteServer: async () => ({ success: true }) },
    {
      resolveServer: (_eggId, body) => {
        assert.equal(body.hostPort, 30007);
        assert.equal(body.port, undefined);
        assert.equal(body.dockerImage, undefined, 'billing payload must not override the plan image');
        return {
          server_id: body.serverId,
          host_port: body.hostPort,
          internal_port: `${body.variables.SERVER_PORT}/tcp`,
        };
      },
    },
    { selectLeastMemoryUtilized: async () => ({ nodeId: 'node-a' }) },
    { findByExternalId: value => value === '42' ? plan : undefined },
    {
      reserveRandomPort: async (record, start, end) => {
        reservation = { record, start, end };
        return { record: { ...record, assignedHostPort: 30007 }, replay: false };
      },
      assignPortAllocations: async (_serverId, count) => {
        requestedPortCount = count;
        return ({
        ...reservation.record,
        assignedHostPort: 30007,
        variables: {
          ...reservation.record.variables,
          AGAPORNIS_PORT_MAPPINGS: JSON.stringify([{ variable: 'SERVER_PORT', internalPort: 25565, hostPort: 30007, protocol: 'tcp' }])
        }
      }); },
      portMappings: variables => JSON.parse(variables.AGAPORNIS_PORT_MAPPINGS),
      finalizeProvisioning: async () => undefined,
      releaseProvisioning: async () => undefined,
    },
    { create: async (_nodeId, request) => { createRequest = request; return { success: true }; } },
    {
      get: id => id === 'node-a' ? node : undefined,
      connectionHost: () => 'node-a.example.test',
    },
    users,
    { dispatch: async (event, payload) => { dispatched = { event, payload }; } },
    { powerAllForServer: async () => undefined },
    { get: name => process.env[name] || '' },
  );

  try {
    const result = await controller.handleWhmcs({
      action: 'AfterModuleCreate',
      productId: '42',
      serviceId: '9001',
      email: 'new-customer@example.com',
      name: 'New Customer',
      dockerImage: 'attacker.example/untrusted:latest',
      portCount: 32,
      variables: {
        PUBLIC_OPTION: 'allowed',
        SERVER_MEMORY: '999999',
        AGAPORNIS_CPU_PINNED_THREADS: '0-99',
      },
    }, { 'x-whmcs-secret': 'webhook-test-secret' });

    const account = users.findByEmail('new-customer@example.com');
    assert.ok(account, 'webhook should create a missing account');
    assert.equal(result.userCreated, true);
    assert.equal(result.user.id, account.id);
    assert.equal(reservation.record.ownerUserId, account.id);
    assert.deepEqual([reservation.start, reservation.end], [30000, 30010]);
    assert.equal(createRequest.host_port, 30007);
    assert.equal(createRequest.internal_port, '25565/tcp');
    assert.equal(reservation.record.cpuLimitPercentage, 150);
    assert.equal(reservation.record.variables.AGAPORNIS_CPU_PINNING, 'true');
    assert.equal(reservation.record.variables.AGAPORNIS_CPU_PINNED_THREADS, '1,3-4');
    assert.equal(reservation.record.variables.AGAPORNIS_SWAP_MEMORY_MB, '256');
    assert.equal(reservation.record.variables.AGAPORNIS_SWAP_MEMORY_STORAGE, 'server');
    assert.equal(reservation.record.variables.PUBLIC_OPTION, 'allowed');
    assert.equal(reservation.record.variables.SERVER_MEMORY, undefined);
    assert.equal(requestedPortCount, 1, 'billing payload must not override the plan port count');
    assert.equal(dispatched.event, 'billing.server.provisioned');
    assert.equal(dispatched.payload.email, 'new-customer@example.com');

    let frozenServer = { id: 'srv-freeze', nodeId: 'node-a', status: 'running', variables: {} };
    let stopped = false;
    const freezeController = new BillingProvisioningController(
      { stopServer: async () => { stopped = true; return { success: true }; } },
      {}, {}, {},
      {
        get: async id => id === frozenServer.id ? frozenServer : undefined,
        isFrozen: server => server?.status === 'frozen' || server?.variables?.AGAPORNIS_FROZEN === 'true',
        updateSettings: async (_id, patch) => { frozenServer = { ...frozenServer, ...patch }; return frozenServer; },
        setStatus: async (_id, status) => { frozenServer = { ...frozenServer, status }; return frozenServer; },
      },
      {}, {}, {},
      { dispatch: async () => undefined },
      { powerAllForServer: async () => undefined },
      { get: name => process.env[name] || '' },
    );
    const frozen = await freezeController.freezeWebhook({ serverId: 'srv-freeze', reason: 'invoice overdue' }, { 'x-agapornis-secret': 'webhook-test-secret' });
    assert.equal(frozen.success, true);
    assert.equal(frozenServer.status, 'frozen');
    assert.equal(frozenServer.variables.AGAPORNIS_FREEZE_REASON, 'invoice overdue');
    assert.equal(stopped, true);
    const unfrozen = await freezeController.unfreezeWebhook({ serverId: 'srv-freeze' }, { 'x-agapornis-secret': 'webhook-test-secret' });
    assert.equal(unfrozen.status, 'stopped');
    assert.equal(frozenServer.variables.AGAPORNIS_FROZEN, undefined);
    console.log('WHMCS account creation and node port allocation test: PASS');
  } finally {
    if (previousSecret === undefined) delete process.env.BILLING_WEBHOOK_SECRET;
    else process.env.BILLING_WEBHOOK_SECRET = previousSecret;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
