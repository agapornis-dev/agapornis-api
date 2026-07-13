const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { NodeStatsService } = require('../src/modules/agents/node-stats.service.ts');

function main() {
  const service = Object.create(NodeStatsService.prototype);
  service.samples = new Map();
  service.sampleLimit = 60;
  service.refreshIntervalMs = 10_000;

  const first = service.withAnalytics({
    nodeId: 'node-1',
    healthy: true,
    collectedAt: '2026-07-11T12:00:00.000Z',
    stats: {
      cpu_percentage: 25,
      memory_usage_bytes: 50,
      memory_total_bytes: 100,
      disk_usage_bytes: 30,
      disk_total_bytes: 100,
    },
  }, 12);
  const second = service.withAnalytics({
    nodeId: 'node-1',
    healthy: true,
    collectedAt: '2026-07-11T12:00:10.000Z',
    stats: {
      cpu_percentage: 40,
      memory_usage_bytes: 75,
      memory_total_bytes: 100,
      disk_usage_bytes: 35,
      disk_total_bytes: 100,
    },
  }, 18);

  assert.equal(first.resourceHistory[0].memoryPercentage, 50);
  assert.equal(second.resourceHistory.length, 2);
  assert.deepEqual(second.resourceHistory[1], {
    at: '2026-07-11T12:00:10.000Z',
    cpuPercentage: 40,
    memoryPercentage: 75,
    diskPercentage: 35,
  });
  assert.deepEqual(second.responseTimeHistoryMs, [12, 18]);
  console.log('node analytics history tests: PASS');
}

main();
