require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const grpc = require('@grpc/grpc-js');
const { ConsoleServerInventoryService } = require('../src/modules/servers/services/console-server-inventory.service');
const { ServerRegistryService } = require('../src/modules/servers/services/server-registry.service');

const healthy = (nodeId, instanceId = '', inventoryInitialized = false) => ({
  nodeId,
  healthy: true,
  stats: {
    agent_instance_id: instanceId,
    console_inventory_initialized: inventoryInitialized,
  },
});
const healthyCamelCase = (nodeId, instanceId, inventoryInitialized) => ({
  nodeId,
  healthy: true,
  stats: {
    agentInstanceId: instanceId,
    consoleInventoryInitialized: inventoryInitialized,
  },
});
const offline = nodeId => ({ nodeId, healthy: false });

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

async function main() {
  const registryView = Object.create(ServerRegistryService.prototype);
  registryView.database = {
    enabled: true,
    query: async () => [
      { id: 'server-b', node_id: 'node-a', status: 'running' },
      { id: 'server-a', node_id: 'node-a', status: 'stopped' },
      { id: 'server-ignored', node_id: 'node-a', status: 'deleting' },
      { id: 'server-c', node_id: 'node-b', status: 'created' },
    ],
  };
  assert.deepEqual(
    Array.from((await registryView.consoleServerIdsByNode()).entries()),
    [
      ['node-a', ['server-a', 'server-b']],
      ['node-b', ['server-c']],
    ],
    'registry inventories are grouped, sorted, and omit transitional servers',
  );

  let initializedListener;
  let initializedRegistryCalls = 0;
  const initializedSyncCalls = [];
  const initializedService = new ConsoleServerInventoryService(
    {
      subscribe(callback) {
        initializedListener = callback;
        callback([]);
        return () => { initializedListener = undefined; };
      },
    },
    {
      consoleServerIdsByNode: async () => {
        initializedRegistryCalls += 1;
        return new Map([['node-hot', ['server-hot']]]);
      },
    },
    {
      syncConsoleServers: async (nodeId, serverIds) => {
        initializedSyncCalls.push({ nodeId, serverIds });
        return { success: true, active_reader_count: serverIds.length };
      },
    },
  );
  initializedService.onApplicationBootstrap();

  initializedListener([healthyCamelCase('node-hot', 'hot-instance-1', true)]);
  await flush();
  assert.equal(initializedRegistryCalls, 0,
    'an API restart does not query inventory for an agent that already initialized it');
  assert.equal(initializedSyncCalls.length, 0,
    'an API restart does not resend inventory to an already-initialized agent');

  initializedListener([healthy('node-hot', 'hot-instance-2', false)]);
  await flush();
  assert.equal(initializedRegistryCalls, 1,
    'a new uninitialized agent process queries the authoritative inventory');
  assert.deepEqual(initializedSyncCalls, [
    { nodeId: 'node-hot', serverIds: ['server-hot'] },
  ], 'a new uninitialized agent process receives exactly one bootstrap sync');
  initializedService.onModuleDestroy();

  let listener;
  let inventories = new Map([
    ['node-a', ['server-b', 'server-a']],
  ]);
  const calls = [];
  const nodeStats = {
    subscribe(callback) {
      listener = callback;
      callback([]);
      return () => { listener = undefined; };
    },
  };
  const registry = {
    consoleServerIdsByNode: async () => inventories,
  };
  const agentClient = {
    syncConsoleServers: async (nodeId, serverIds) => {
      calls.push({ nodeId, serverIds });
      return { success: true, active_reader_count: serverIds.length };
    },
  };
  const service = new ConsoleServerInventoryService(nodeStats, registry, agentClient);
  service.onApplicationBootstrap();

  listener([healthy('node-a', 'instance-a-1'), healthy('node-empty', 'instance-empty-1')]);
  await flush();
  assert.deepEqual(calls, [
    { nodeId: 'node-a', serverIds: ['server-a', 'server-b'] },
    { nodeId: 'node-empty', serverIds: [] },
  ], 'healthy nodes receive a sorted authoritative inventory, including an empty inventory');

  listener([healthy('node-a', 'instance-a-1'), healthy('node-empty', 'instance-empty-1')]);
  await flush();
  assert.equal(calls.length, 2, 'an unchanged inventory is deduplicated');

  listener([healthy('node-a', 'instance-a-2'), healthy('node-empty', 'instance-empty-1')]);
  await flush();
  assert.deepEqual(calls.at(-1), {
    nodeId: 'node-a',
    serverIds: ['server-a', 'server-b'],
  }, 'a new agent process instance receives the unchanged inventory immediately');

  inventories = new Map([['node-a', ['server-c']]]);
  listener([healthy('node-a', 'instance-a-2'), healthy('node-empty', 'instance-empty-1')]);
  await flush();
  assert.equal(calls.length, 3, 'server-list changes do not resend after process bootstrap');

  listener([offline('node-a'), healthy('node-empty', 'instance-empty-1')]);
  await flush();
  listener([healthy('node-a', 'instance-a-2'), healthy('node-empty', 'instance-empty-1')]);
  await flush();
  assert.equal(calls.length, 3, 'a transient reconnect does not resend to the same agent process');

  listener([healthy('node-empty', 'instance-empty-1')]);
  await flush();
  listener([healthy('node-a', 'instance-a-2'), healthy('node-empty', 'instance-empty-1')]);
  await flush();
  assert.deepEqual(calls.at(-1), {
    nodeId: 'node-a',
    serverIds: ['server-c'],
  }, 'deleting and re-adding a node ID bootstraps it again');
  assert.equal(calls.length, 4);

  let failedCalls = 0;
  agentClient.syncConsoleServers = async nodeId => {
    if (nodeId === 'retry') {
      failedCalls += 1;
      if (failedCalls === 1) throw new Error('temporary failure');
    }
    return { success: true };
  };
  listener([healthy('retry', 'retry-1')]);
  await flush();
  listener([healthy('retry', 'retry-1')]);
  await flush();
  listener([healthy('retry', 'retry-1')]);
  await flush();
  assert.equal(failedCalls, 2, 'a failed initial bootstrap retries until it succeeds, then stops');

  let legacyCalls = 0;
  agentClient.syncConsoleServers = async nodeId => {
    if (nodeId === 'legacy') {
      legacyCalls += 1;
      throw Object.assign(new Error('not implemented'), { code: grpc.status.UNIMPLEMENTED });
    }
    return { success: true };
  };
  listener([healthy('legacy', 'legacy-1')]);
  await flush();
  listener([healthy('legacy', 'legacy-1')]);
  await flush();
  assert.equal(legacyCalls, 1, 'legacy agents are not called repeatedly');
  listener([offline('legacy')]);
  await flush();
  listener([healthy('legacy', 'legacy-1')]);
  await flush();
  assert.equal(legacyCalls, 1, 'a reconnect does not retry an unsupported process');
  listener([healthy('legacy', 'legacy-2')]);
  await flush();
  assert.equal(legacyCalls, 2, 'a changed process instance retries a previously unsupported agent');

  service.onModuleDestroy();
  console.log('console server inventory tests: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
