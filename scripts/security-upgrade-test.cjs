require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { AuthService } = require('../src/modules/auth/auth.service');
const { JwtAuthGuard } = require('../src/modules/security/jwt-auth.guard');
const { UsersService } = require('../src/modules/users/users.service');
const { loadApiTlsOptions } = require('../src/common/config/api-tls');
const { tokenDigest, tokenDigestCandidates } = require('../src/common/security/token-digest');

async function main() {
  const digest = tokenDigest('opaque-secret');
  assert.equal(digest.length, 128);
  assert.equal(tokenDigestCandidates('opaque-secret')[0], digest);
  assert.equal(tokenDigestCandidates('opaque-secret')[1].length, 64);

  const auth = new AuthService(
    { enforceMaintenance: () => undefined },
    { assertAllowed: () => undefined, requestIp: () => '127.0.0.1' },
    { userJwtSecret: () => 'security-upgrade-test-secret-with-enough-entropy' },
    { get: (_name, fallback = '') => fallback },
  );
  const user = {
    id: 'user-1',
    email: 'user@example.test',
    name: 'User',
    role: 'user',
    passwordHash: 'unused',
    createdAt: new Date().toISOString(),
    sessionVersion: 0,
  };
  const token = auth.signForUser(user);
  assert.equal(jwt.decode(token, { complete: true }).header.alg, 'HS512');
  assert.equal(auth.verifyUserToken(token).sub, user.id);
  const challengeToken = auth.signTwoFactorLoginChallenge(user.id, user.sessionVersion);
  assert.equal(auth.verifyTwoFactorLoginChallenge(challengeToken).ver, user.sessionVersion);

  const users = Object.create(UsersService.prototype);
  users.users = new Map([[user.id, user]]);
  users.repository = { enabled: false };
  users.dataFile = path.join(os.tmpdir(), `agapornis-users-${process.pid}.json`);
  users.logger = { error: () => undefined };
  users.findByIdForAuth = UsersService.prototype.findByIdForAuth.bind(users);
  users.publicUser = UsersService.prototype.publicUser.bind(users);

  const guard = new JwtAuthGuard(auth, users, { getAllAndOverride: () => false });
  const request = { headers: { authorization: `Bearer ${token}` } };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  assert.equal(await guard.canActivate(context), true);
  const revocation = await UsersService.prototype.revokeAllSessions.call(users, user.id);
  assert.equal(revocation.revoked, true);
  assert.equal(user.sessionVersion, 1);
  await assert.rejects(guard.canActivate(context), /invalid token/);

  const ipPrefix = UsersService.prototype.ipPrefix.call(users, '127.0.0.1');
  user.loginSecurity = {
    knownLogins: [{
      fingerprint: crypto.createHash('sha256').update(`${ipPrefix}|test-browser`).digest('hex'),
      ipPrefix,
      userAgent: 'test-browser',
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }],
  };
  const observed = UsersService.prototype.observeLogin.call(
    users,
    user,
    { ip: '127.0.0.1', userAgent: 'test-browser' },
    new Date().toISOString(),
  );
  assert.equal(observed.suspicious, false);
  assert.equal(user.loginSecurity.knownLogins[0].fingerprint.length, 128);
  fs.rmSync(users.dataFile, { force: true });

  let sharedUser = { ...user, sessionVersion: 4 };
  const replica = Object.create(UsersService.prototype);
  replica.users = new Map([[user.id, { ...user, sessionVersion: 3 }]]);
  replica.repository = {
    enabled: true,
    findById: async () => ({ ...sharedUser }),
    findByEmail: async () => ({ ...sharedUser }),
    incrementSessionVersion: async () => {
      sharedUser = { ...sharedUser, sessionVersion: sharedUser.sessionVersion + 1 };
      return { ...sharedUser };
    },
  };
  replica.findById = UsersService.prototype.findById.bind(replica);
  const fresh = await UsersService.prototype.findByIdForAuth.call(replica, user.id);
  assert.equal(fresh.sessionVersion, 4);
  assert.equal(
    (await UsersService.prototype.findByEmailForAuth.call(replica, user.email)).sessionVersion,
    4,
  );
  const clusteredRevocation = await UsersService.prototype.revokeAllSessions.call(replica, user.id);
  assert.equal(clusteredRevocation.sessionVersion, 5);
  assert.equal((await UsersService.prototype.findByIdForAuth.call(replica, user.id)).sessionVersion, 5);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agapornis-tls-'));
  const keyPath = path.join(directory, 'api.key');
  const certPath = path.join(directory, 'api.crt');
  fs.writeFileSync(keyPath, 'test-key');
  fs.writeFileSync(certPath, 'test-cert');
  const values = {
    API_TLS_KEY_PATH: keyPath,
    API_TLS_CERT_PATH: certPath,
  };
  const config = {
    get: (name, fallback = '') => values[name] ?? fallback,
    bool: name => values[name] === 'true',
  };
  const tls = loadApiTlsOptions(config);
  assert.equal(tls.key.toString(), 'test-key');
  assert.equal(tls.cert.toString(), 'test-cert');
  assert.throws(
    () => loadApiTlsOptions({ get: name => name === 'API_TLS_KEY_PATH' ? keyPath : '', bool: () => false }),
    /requires both/,
  );
  assert.throws(
    () => loadApiTlsOptions({ get: name => name === 'API_TLS_CA_PATH' ? certPath : '', bool: () => false }),
    /requires both/,
  );
  fs.rmSync(directory, { recursive: true, force: true });

  console.log('SHA3-512 digests, HS512 JWTs, revoke-all, and native TLS configuration test: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
