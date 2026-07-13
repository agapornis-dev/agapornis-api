import { performance } from 'node:perf_hooks';

const baseUrl = (process.env.STRESS_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const durationMs = positive('STRESS_DURATION_SECONDS', 10) * 1_000;
const concurrency = positive('STRESS_CONCURRENCY', 50);
const sseConnections = positive('STRESS_SSE_CONNECTIONS', 0, true);
const maxP95Ms = positive('STRESS_MAX_P95_MS', 1_000);
const maxErrorRate = Number(process.env.STRESS_MAX_ERROR_RATE || 0.01);
const token = process.env.STRESS_TOKEN || '';
const cookie = process.env.STRESS_COOKIE || '';
const headers = {
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...(cookie ? { cookie } : {})
};
const paths = token || cookie
  ? ['/api/settings/public', '/api/agents', '/api/agents/stats']
  : ['/api/settings/public'];

const latencies = [];
let requests = 0;
let failures = 0;
const statusCounts = new Map();
const started = performance.now();
const deadline = started + durationMs;

const sseAbort = new AbortController();
const streams = Array.from({ length: sseConnections }, () => openStatsStream(sseAbort.signal));
await Promise.all(Array.from({ length: concurrency }, (_, worker) => runWorker(worker)));
sseAbort.abort();
await Promise.allSettled(streams);

const elapsedSeconds = (performance.now() - started) / 1_000;
latencies.sort((a, b) => a - b);
const errorRate = requests ? failures / requests : 1;
const summary = {
  baseUrl,
  durationSeconds: Number(elapsedSeconds.toFixed(2)),
  concurrency,
  sseConnections,
  requests,
  requestsPerSecond: Number((requests / elapsedSeconds).toFixed(1)),
  failures,
  errorRate: Number(errorRate.toFixed(4)),
  latencyMs: {
    p50: percentile(0.50),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: Number((latencies.at(-1) || 0).toFixed(1))
  },
  statuses: Object.fromEntries([...statusCounts.entries()].sort())
};

console.log(JSON.stringify(summary, null, 2));
if (errorRate > maxErrorRate || summary.latencyMs.p95 > maxP95Ms) {
  console.error(`Stress test failed thresholds: errorRate <= ${maxErrorRate}, p95 <= ${maxP95Ms}ms`);
  process.exitCode = 1;
}

async function runWorker(worker) {
  let index = worker;
  while (performance.now() < deadline) {
    const path = paths[index++ % paths.length];
    const requestStarted = performance.now();
    try {
      const response = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(5_000) });
      await response.arrayBuffer();
      const status = String(response.status);
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
      if (!response.ok) failures++;
    } catch {
      statusCounts.set('network-error', (statusCounts.get('network-error') || 0) + 1);
      failures++;
    } finally {
      requests++;
      latencies.push(performance.now() - requestStarted);
    }
  }
}

async function openStatsStream(signal) {
  if (!token && !cookie) return;
  try {
    const response = await fetch(`${baseUrl}/api/agents/stats/stream`, { headers, signal });
    if (!response.ok || !response.body) {
      failures++;
      return;
    }
    const reader = response.body.getReader();
    while (!signal.aborted) await reader.read();
  } catch (error) {
    if (!signal.aborted) failures++;
  }
}

function percentile(fraction) {
  if (!latencies.length) return 0;
  const index = Math.min(latencies.length - 1, Math.ceil(latencies.length * fraction) - 1);
  return Number(latencies[index].toFixed(1));
}

function positive(name, fallback, allowZero = false) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) return fallback;
  return Math.floor(value);
}
