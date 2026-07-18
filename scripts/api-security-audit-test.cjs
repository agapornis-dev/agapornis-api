require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { trustedRequestIp } = require('../src/common/security/request-ip');
const { hasTrustedRequestOrigin } = require('../src/modules/security/csrf.guard');
const { SocialAuthService } = require('../src/modules/auth/social-auth.service');
const { WebhooksService } = require('../src/modules/webhooks/webhooks.service');
const { ServerRegistryService } = require('../src/modules/servers/services/server-registry.service');
const { normalizeServerStatus } = require('../src/modules/servers/services/server-status');

async function main() {
  assert.equal(trustedRequestIp({
    ip: '203.0.113.20',
    headers: { 'x-forwarded-for': '127.0.0.1' },
  }), '203.0.113.20');

  assert.equal(hasTrustedRequestOrigin({
    protocol: 'https',
    hostname: 'api.example.test',
    headers: {
      host: 'api.example.test',
      origin: 'https://attacker.example.test',
      'x-forwarded-host': 'attacker.example.test',
      'x-forwarded-proto': 'https',
    },
  }), false, 'untrusted forwarding headers must not create a trusted CSRF origin');

  const social = new SocialAuthService({
    panelPublicUrl: () => 'https://panel.example.test',
    socialProvider: () => ({ clientId: 'client', clientSecret: 'secret' }),
  }, {}, { isProduction: () => true });
  const flow = { state: 's'.repeat(32), codeChallenge: 'c'.repeat(43) };
  assert.match(social.authorizationUrl('google', {
    ...flow,
    redirectUri: 'https://panel.example.test/api/auth/oauth/callback',
  }), /accounts\.google\.com/);
  assert.throws(() => social.authorizationUrl('google', {
    ...flow,
    redirectUri: 'https://attacker.example.test/api/auth/oauth/callback',
  }), /invalid OAuth redirect URI/);
  assert.throws(() => social.authorizationUrl('google', {
    state: '<script>'.repeat(8),
    codeChallenge: 'c'.repeat(43),
    redirectUri: 'https://panel.example.test/api/auth/oauth/callback',
  }), /invalid OAuth state/);

  const webhooks = Object.create(WebhooksService.prototype);
  await assert.rejects(
    webhooks.dispatch('event\r\nHost: internal', {}),
    /webhook event type is invalid/,
  );

  const registry = Object.create(ServerRegistryService.prototype);
  registry.database = { enabled: false, clientType: 'json' };
  registry.reservationLocks = new Map();
  registry.servers = new Map([['server-1', {
    id: 'server-1', nodeId: 'node-1', ownerUserId: 'owner-1', eggId: 'minecraft',
    name: 'Server', status: 'offline', createdAt: new Date().toISOString(),
  }]]);
  registry.save = () => undefined;
  const replay = await registry.reserve({
    id: 'server-1', nodeId: 'node-1', ownerUserId: 'owner-1', eggId: 'minecraft',
    name: 'Server', status: 'provisioning', createdAt: new Date().toISOString(),
  });
  assert.equal(replay.replay, true);
  await assert.rejects(registry.reserve({
    id: 'server-1', nodeId: 'node-1', ownerUserId: 'different-owner', eggId: 'minecraft',
    name: 'Server', status: 'provisioning', createdAt: new Date().toISOString(),
  }), /different server/);

  const concurrentRecord = {
    id: 'server-2', nodeId: 'node-1', ownerUserId: 'owner-1', eggId: 'minecraft',
    name: 'Concurrent server', status: 'provisioning', createdAt: new Date().toISOString(),
  };
  const concurrentReservations = await Promise.allSettled([
    registry.reserve(concurrentRecord),
    registry.reserve(concurrentRecord),
  ]);
  assert.equal(concurrentReservations.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrentReservations.filter(result => result.status === 'rejected').length, 1);
  assert.match(
    String(concurrentReservations.find(result => result.status === 'rejected').reason),
    /already provisioning/,
    'single-process storage must serialize duplicate billing webhooks',
  );

  registry.servers.get('server-1').status = 'transferring';
  await registry.setStatus('server-1', 'running');
  assert.equal(registry.servers.get('server-1').status, 'transferring');
  assert.equal(normalizeServerStatus('EXITED'), 'offline');

  console.log('API trust-boundary and business-invariant security tests: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
