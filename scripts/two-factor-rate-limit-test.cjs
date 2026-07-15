require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { TwoFactorService } = require('../src/modules/auth/two-factor.service');

class SharedRedisRateLimits {
  constructor() {
    this.enabled = true;
    this.counts = new Map();
    this.hits = [];
  }

  async hitSlidingWindowRateLimit(key, windowSeconds, maximum) {
    this.hits.push({ key, windowSeconds, maximum });
    const count = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, count);
    return count <= maximum;
  }

  async clearRateLimit(key) {
    this.counts.delete(key);
  }
}

async function main() {
  const redis = new SharedRedisRateLimits();
  const firstReplica = new TwoFactorService({}, redis);
  const secondReplica = new TwoFactorService({}, redis);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const replica = attempt % 2 === 0 ? firstReplica : secondReplica;
    await replica.enforceAttemptLimit('user-1');
  }
  await assert.rejects(
    secondReplica.enforceAttemptLimit('user-1'),
    /too many two-factor attempts/,
  );
  assert.deepEqual(redis.hits[0], {
    key: 'two-factor:user-1',
    windowSeconds: 300,
    maximum: 10,
  });

  await firstReplica.clearAttemptLimit('user-1');
  await secondReplica.enforceAttemptLimit('user-1');

  const disabledRedis = { enabled: false };
  const localReplica = new TwoFactorService({}, disabledRedis);
  const independentReplica = new TwoFactorService({}, disabledRedis);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await localReplica.enforceAttemptLimit('user-2');
  }
  await assert.rejects(
    localReplica.enforceAttemptLimit('user-2'),
    /too many two-factor attempts/,
  );
  await independentReplica.enforceAttemptLimit('user-2');

  console.log('distributed 2FA attempt rate limit test: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
