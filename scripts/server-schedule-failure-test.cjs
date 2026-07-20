const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { COLLECTION_TABLES } = require('../src/modules/database/schema');
const { ActivityLogService } = require('../src/modules/activity-log/activity-log.service.ts');
const { ServerSchedulesService } = require('../src/modules/servers/services/server-schedules.service.ts');

function record(overrides = {}) {
  return {
    id: 'schedule-1',
    serverId: 'server-1',
    nodeId: 'node-1',
    name: 'Broken command',
    enabled: true,
    intervalSeconds: 60,
    action: 'command',
    command: 'status',
    actorUserId: 'user-1',
    consecutiveFailures: 0,
    nextRunAt: '2026-07-20T00:01:00.000Z',
    createdAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function harness(executeExclusive) {
  const service = Object.create(ServerSchedulesService.prototype);
  const errors = [];
  const activity = [];
  let saves = 0;
  let reschedules = 0;

  service.schedules = new Map();
  service.timers = new Map();
  service.executions = new Map();
  service.logger = {
    log: () => undefined,
    error: message => errors.push(message),
  };
  service.activityLog = { log: entry => activity.push(entry) };
  service.executeExclusive = executeExclusive;
  service.save = () => { saves += 1; };
  service.schedule = () => { reschedules += 1; };

  return {
    service,
    errors,
    activity,
    saves: () => saves,
    reschedules: () => reschedules,
  };
}

async function main() {
  const reason = '13 INTERNAL: No such file or directory (os error 2)';
  const failures = harness(async () => { throw new Error(reason); });
  failures.service.schedules.set('schedule-1', record());

  for (let expected = 1; expected <= 2; expected += 1) {
    await failures.service.runScheduled(failures.service.schedules.get('schedule-1'));
    assert.equal(failures.service.schedules.get('schedule-1').consecutiveFailures, expected);
    assert.equal(failures.reschedules(), expected);
    assert.match(failures.errors[expected - 1], new RegExp(`\\(${expected}/3 consecutive failures\\)`));
  }

  await failures.service.runScheduled(failures.service.schedules.get('schedule-1'));
  assert.equal(failures.service.schedules.has('schedule-1'), false, 'third failure must remove the schedule');
  assert.equal(failures.saves(), 3, 'each changed failure count and the removal must be persisted');
  assert.equal(failures.reschedules(), 2, 'a removed schedule must not be armed again');
  assert.equal(failures.errors.length, 3, 'the third attempt should emit one final backend line');
  assert.match(failures.errors[2], /automatically removed after 3 consecutive failures/);
  assert.match(failures.errors[2], new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(failures.activity, [{
    event: 'server.schedule_removed_after_failures',
    serverId: 'server-1',
    nodeId: 'node-1',
    meta: {
      scheduleId: 'schedule-1',
      scheduleName: 'Broken command',
      action: 'command',
      failureCount: 3,
      reason,
    },
  }]);

  const recovery = harness(async () => ({ success: true }));
  recovery.service.schedules.set('schedule-1', record({ consecutiveFailures: 2 }));
  await recovery.service.runScheduled(recovery.service.schedules.get('schedule-1'));
  assert.equal(recovery.service.schedules.get('schedule-1').consecutiveFailures, 0);
  assert.equal(recovery.reschedules(), 1);
  assert.deepEqual(recovery.errors, []);
  assert.deepEqual(recovery.activity, []);

  const manual = harness(async () => { throw new Error(reason); });
  const manualRecord = record({ consecutiveFailures: 2 });
  manual.service.schedules.set('schedule-1', manualRecord);
  await assert.rejects(manual.service.runNow('schedule-1', 'server-1'), error => error.message === reason);
  assert.equal(manual.service.schedules.get('schedule-1'), manualRecord);
  assert.equal(manual.service.schedules.get('schedule-1').consecutiveFailures, 2);
  assert.equal(manual.saves(), 0);
  assert.equal(manual.reschedules(), 0);

  const scheduleTable = COLLECTION_TABLES['server-schedules'];
  const persisted = record({ consecutiveFailures: 2 });
  const row = {
    schedule_id: persisted.id,
    ...Object.fromEntries(scheduleTable.columns.map((column, index) => [column.name, scheduleTable.toRow(persisted)[index]])),
  };
  assert.equal(row.consecutive_failures, 2);
  assert.equal(scheduleTable.fromRow(row).consecutiveFailures, 2);
  assert.equal(scheduleTable.toRow(record({ consecutiveFailures: undefined }))[scheduleTable.columns.findIndex(column => column.name === 'consecutive_failures')], 0);

  const activityService = Object.create(ActivityLogService.prototype);
  const safeRemoval = activityService.sanitizeServerEntry({
    id: 'activity-1',
    event: 'server.schedule_removed_after_failures',
    userId: 'user-1',
    userEmail: 'user@example.test',
    serverId: 'server-1',
    nodeId: 'node-1',
    ip: '192.0.2.1',
    meta: failures.activity[0].meta,
    createdAt: '2026-07-20T00:03:00.000Z',
  });
  assert.deepEqual(safeRemoval.meta, {
    scheduleId: 'schedule-1',
    scheduleName: 'Broken command',
    action: 'command',
    failureCount: 3,
    reason: 'The scheduled action could not be completed.',
  });
  assert.notEqual(safeRemoval.meta.reason, reason, 'raw infrastructure errors must stay in the admin audit log');
  assert.equal(safeRemoval.userId, undefined);
  assert.equal(safeRemoval.serverId, undefined);
  const unrelated = activityService.sanitizeServerEntry({
    id: 'activity-2',
    event: 'server.command',
    meta: { command: 'secret' },
    createdAt: '2026-07-20T00:04:00.000Z',
  });
  assert.equal(unrelated.meta, undefined, 'unrelated free-form server metadata must remain private');

  console.log('server schedule consecutive failure tests: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
