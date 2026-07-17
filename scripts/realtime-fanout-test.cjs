require('ts-node/register/transpile-only');

process.env.SERVER_STATS_STREAM_INTERVAL_MS = '20';
process.env.SERVER_STATS_DISCONNECT_GRACE_MS = '50';
process.env.SERVER_STATS_STREAM_START_DELAY_MS = '20';
process.env.SERVER_CONSOLE_STREAM_START_DELAY_MS = '20';
process.env.SERVER_CONSOLE_BATCH_DELAY_MS = '5';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ServerRealtimeService } = require('../src/modules/servers/realtime/server-realtime.service');

const config = {
  positiveInt(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  },
  int(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) ? value : fallback;
  },
};

async function main() {
  let sample = 0;
  const client = {
    getServerStats: async () => ({ status: 'running', cpu_percentage: ++sample })
  };
  const registry = { get: async () => ({ diskLimitBytes: 1024 }) };
  const support = { recordObservedStatus: async () => undefined };
  const realtime = new ServerRealtimeService(client, registry, support, config);
  const first = [];
  const second = [];

  const unsubscribeFirst = realtime.subscribeStats('node-a', 'server-a', event => first.push(event));
  await waitFor(() => first.length >= 2, 'first subscriber did not receive stats');

  const unsubscribeSecond = realtime.subscribeStats('node-a', 'server-a', event => second.push(event));
  await waitFor(() => second.length >= 2, 'second subscriber did not receive shared stats');

  unsubscribeFirst();
  const secondBeforeDisconnect = second.length;
  await waitFor(
    () => second.length > secondBeforeDisconnect,
    'remaining subscriber stopped after the first subscriber disconnected'
  );

  unsubscribeSecond();
  const samplesAtDisconnect = sample;
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(sample, samplesAtDisconnect, 'an idle feed continued polling the agent during its cache grace window');

  const resumed = [];
  const unsubscribeResumed = realtime.subscribeStats('node-a', 'server-a', event => resumed.push(event));
  assert.equal(resumed.length, 1, 'a returning listener did not receive the cached sample immediately');
  await waitFor(() => sample > samplesAtDisconnect, 'a returning listener did not restart fresh stats polling');
  unsubscribeResumed();
  await waitFor(() => realtime.statsFeeds.size === 0, 'shared feed was not cleaned up after the grace window');
  realtime.onModuleDestroy();

  process.env.SERVER_STATS_STREAM_INTERVAL_MS = '50';
  process.env.SERVER_STATS_STREAM_START_DELAY_MS = '0';
  const pollStarts = [];
  let activePolls = 0;
  let maxActivePolls = 0;
  const cadenceRealtime = new ServerRealtimeService({
    getServerStats: async () => {
      pollStarts.push(Date.now());
      activePolls += 1;
      maxActivePolls = Math.max(maxActivePolls, activePolls);
      await new Promise(resolve => setTimeout(resolve, 80));
      activePolls -= 1;
      return { status: 'running' };
    }
  }, registry, support, config);
  const unsubscribeCadence = cadenceRealtime.subscribeStats('node-a', 'server-cadence', () => undefined);
  await waitFor(() => pollStarts.length >= 3, 'near-live stats cadence did not start');
  const cadenceGaps = pollStarts.slice(1).map((startedAt, index) => startedAt - pollStarts[index]);
  assert.ok(Math.max(...cadenceGaps) < 115, `stats polling slept after slow samples: ${cadenceGaps.join(', ')}ms`);
  assert.equal(maxActivePolls, 1, 'near-live polling overlapped agent requests');
  unsubscribeCadence();
  cadenceRealtime.onModuleDestroy();
  process.env.SERVER_STATS_STREAM_INTERVAL_MS = '20';
  process.env.SERVER_STATS_STREAM_START_DELAY_MS = '20';

  const frozenEvents = [];
  const frozenRealtime = new ServerRealtimeService(
    { getServerStats: async () => ({ status: 'exited' }) },
    registry,
    { recordObservedStatus: async () => 'frozen' },
    config,
  );
  const unsubscribeFrozen = frozenRealtime.subscribeStats(
    'node-a',
    'server-frozen',
    event => frozenEvents.push(event)
  );
  await waitFor(() => frozenEvents.length >= 3, 'frozen server did not keep emitting stats events');
  assert.ok(
    frozenEvents.every(event => event.payload.data.status === 'frozen'),
    'raw container exit status replaced the authoritative frozen state'
  );
  unsubscribeFrozen();
  frozenRealtime.onModuleDestroy();

  let requestStarted = false;
  let requestAborted = false;
  const slowClient = {
    getServerStats: (_nodeId, _serverId, _token, signal) => new Promise((resolve, reject) => {
      requestStarted = true;
      signal.addEventListener('abort', () => {
        requestAborted = true;
        reject(new Error('cancelled'));
      }, { once: true });
    })
  };
  const cancellationRealtime = new ServerRealtimeService(slowClient, registry, support, config);
  const unsubscribeSlow = cancellationRealtime.subscribeStats('node-a', 'server-slow', () => undefined);
  await waitFor(() => requestStarted, 'slow stats request did not start');
  unsubscribeSlow();
  await waitFor(() => requestAborted, 'switching away did not cancel the in-flight agent request');
  cancellationRealtime.onModuleDestroy();

  let transientStatsCalls = 0;
  let consoleStarts = 0;
  let consoleCancels = 0;
  let activeConsoleCall;
  const churnClient = {
    getServerStats: async () => {
      transientStatsCalls += 1;
      return { status: 'running' };
    },
    streamConsole: () => {
      consoleStarts += 1;
      const call = new EventEmitter();
      call.cancel = () => { consoleCancels += 1; };
      activeConsoleCall = call;
      return call;
    }
  };
  const churnRealtime = new ServerRealtimeService(churnClient, registry, support, config);
  for (let index = 0; index < 50; index += 1) {
    churnRealtime.subscribeStats('node-a', `transient-stats-${index}`, () => undefined)();
    churnRealtime.subscribeConsole('node-a', `transient-console-${index}`, () => undefined)();
  }
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(transientStatsCalls, 0, 'rapid transient stats selections reached the agent');
  assert.equal(consoleStarts, 0, 'rapid transient console selections opened gRPC streams');

  const firstConsoleEvents = [];
  const unsubscribeConsole = churnRealtime.subscribeConsole('node-a', 'stable-console', event => firstConsoleEvents.push(event));
  await waitFor(() => consoleStarts === 1, 'a stable console selection did not start after the churn window');
  for (let index = 0; index < 200; index += 1) {
    activeConsoleCall.emit('data', { log_line: `line-${index}`, replayed: false, _replayed: 'replayed' });
  }
  await waitFor(() => firstConsoleEvents.flatMap(event => event.payload.line.split('\n')).length === 200, 'live console batching dropped lines');
  assert.ok(firstConsoleEvents.length < 20, 'live console lines were still broadcast one event at a time');
  assert.ok(firstConsoleEvents.every(event => event.payload.replayed === false), 'live console lines were marked as history');

  const replayedConsoleEvents = [];
  const unsubscribeReplay = churnRealtime.subscribeConsole('node-a', 'stable-console', event => replayedConsoleEvents.push(event));
  assert.equal(consoleStarts, 1, 'a second viewer opened a duplicate console stream');
  assert.equal(replayedConsoleEvents.flatMap(event => event.payload.line.split('\n')).length, 200, 'console replay dropped history');
  assert.ok(replayedConsoleEvents.length <= 2, 'cached console history was replayed as too many SSE events');
  assert.ok(replayedConsoleEvents.every(event => event.payload.replayed === true), 'cached console history was marked as live output');
  const diagnostics = churnRealtime.diagnostics();
  assert.equal(diagnostics.realtime.counters.transientStatsSelections, 50);
  assert.equal(diagnostics.realtime.counters.transientConsoleSelections, 50);
  assert.equal(diagnostics.realtime.counters.consoleMessagesReceived, 200);
  assert.ok(diagnostics.realtime.counters.consoleBatchesBroadcast < 20);
  activeConsoleCall.emit('error', new Error('Error in input stream'));
  await waitFor(() => consoleStarts === 2, 'an input stream error did not reconnect the shared console feed');
  unsubscribeReplay();
  unsubscribeConsole();
  assert.equal(consoleCancels, 1, 'the stable console stream was not cancelled on disconnect');
  churnRealtime.onModuleDestroy();

  console.log('Realtime fan-out self-test passed: listeners share work, transient selections stay local, idle feeds stop, cached feeds resume, and abandoned RPCs cancel.');
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
