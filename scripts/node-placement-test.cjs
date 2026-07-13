const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { ServerPlacementService } = require('../src/modules/servers/services/server-placement.service.ts');
const { ServerRegistryService } = require('../src/modules/servers/services/server-registry.service.ts');

async function main() {
  const agentRows = [
      { nodeId: 'fra-busy', location: 'Frankfurt', portRangeStart: 25000, portRangeEnd: 25009 },
      { nodeId: 'fra-free', location: 'Frankfurt', portRangeStart: 26000, portRangeEnd: 26009 },
      { nodeId: 'hel-free', location: 'Helsinki', portRangeStart: 27000, portRangeEnd: 27009 }
  ];
  const agents = { list: () => agentRows };
  const nodeStats = {
    listFresh: async () => [
      { nodeId: 'fra-busy', healthy: true, stats: { memory_usage_bytes: 20, memory_total_bytes: 100, disk_total_bytes: 100 } },
      { nodeId: 'fra-free', healthy: true, stats: { memory_usage_bytes: 40, memory_total_bytes: 100, disk_total_bytes: 100 } },
      { nodeId: 'hel-free', healthy: true, stats: { memory_usage_bytes: 10, memory_total_bytes: 100, disk_total_bytes: 100 } }
    ]
  };
  const capacities = new Map([
    ['fra-busy', { total: 10, used: 10, available: 0, exhausted: true }],
    ['fra-free', { total: 10, used: 2, available: 8, exhausted: false }],
    ['hel-free', { total: 10, used: 0, available: 10, exhausted: false }]
  ]);
  const registry = { portCapacity: async nodeId => capacities.get(nodeId), list: async () => [] };
  const placement = new ServerPlacementService(agents, nodeStats, registry);

  const selected = await placement.selectLeastMemoryUtilized(10, 'Frankfurt');
  assert.equal(selected.nodeId, 'fra-free', 'an exhausted lower-RAM node must be skipped');
  assert.equal(selected.location, 'frankfurt');
  assert.equal(selected.availablePorts, 8);

  const helsinki = await placement.selectLeastMemoryUtilized(10, 'Helsinki');
  assert.equal(helsinki.nodeId, 'hel-free', 'placement must stay inside the selected location');

  const pinned = await placement.selectLeastMemoryUtilized(10, 'FRANKFURT', 'fra-free');
  assert.equal(pinned.nodeId, 'fra-free', 'an explicit node pin must be honored');
  assert.equal(pinned.location, 'frankfurt', 'returned locations must be normalized');
  agentRows.find(agent => agent.nodeId === 'fra-free').maintenanceMode = true;
  await assert.rejects(
    placement.selectLeastMemoryUtilized(10, 'frankfurt', 'fra-free'),
    /maintenance mode/,
    'maintenance nodes must reject new placement'
  );
  agentRows.find(agent => agent.nodeId === 'fra-free').maintenanceMode = false;
  Object.assign(agentRows.find(agent => agent.nodeId === 'fra-free'), {
    memoryLimitBytes: 50,
    memoryOverallocationBytes: 10,
    diskLimitBytes: 70,
    diskOverallocationBytes: 5
  });
  const capacity = (await placement.capacityList()).find(row => row.nodeId === 'fra-free');
  assert.equal(capacity.memoryCapacityBytes, 60, 'RAM capacity is the configured limit plus over-allocation');
  assert.equal(capacity.diskCapacityBytes, 75, 'disk capacity is the configured limit plus over-allocation');
  await assert.rejects(
    placement.selectLeastMemoryUtilized(10, 'helsinki', 'fra-free'),
    /node "fra-free" is not in location "helsinki"/
  );

  capacities.set('fra-free', { total: 10, used: 10, available: 0, exhausted: true });
  await assert.rejects(
    placement.selectLeastMemoryUtilized(10, 'Frankfurt'),
    /all game ports are in use in location "frankfurt"/
  );

  const portRegistry = Object.create(ServerRegistryService.prototype);
  portRegistry.list = async () => [
    { nodeId: 'node-a', assignedHostPort: 25565 },
    { nodeId: 'node-b', assignedHostPort: 25566 }
  ];
  assert.equal(await portRegistry.allocateRandomPort('node-b', 25565, 25565), 25565, 'the same port may be used on different nodes');
  await assert.rejects(portRegistry.allocateRandomPort('node-a', 25565, 25565), /no available ports/);

  console.log('Node placement self-test passed: locations, maintenance, RAM/disk capacity, node pins, and port exhaustion are enforced.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
