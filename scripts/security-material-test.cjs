require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SecurityMaterialService } = require('../src/modules/auth/security-material.service');

class SharedDatabase {
  constructor() {
    this.enabled = true;
    this.value = undefined;
  }

  async init() {}

  placeholders(count) {
    return Array.from({ length: count }, () => '?').join(', ');
  }

  async advisoryLock() {}

  isUniqueViolation() {
    return false;
  }

  async query(sql) {
    if (/SELECT value FROM cluster_security/.test(sql)) {
      return this.value === undefined ? [] : [{ value: this.value }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  }

  async transaction(work) {
    return work({
      clientType: 'postgres',
      placeholders: this.placeholders.bind(this),
      query: async (sql, params) => {
        if (/SELECT value FROM cluster_security/.test(sql)) {
          return this.value === undefined ? [] : [{ value: this.value }];
        }
        if (/INSERT INTO cluster_security/.test(sql)) {
          this.value = params[1];
          return [];
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      },
    });
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agapornis-security-'));
  const database = new SharedDatabase();
  const previous = {
    keysDir: process.env.KEYS_DIR,
    jwt: process.env.APP_JWT_SECRET,
    twoFactor: process.env.TWO_FACTOR_ENCRYPTION_KEY,
  };

  try {
    process.env.KEYS_DIR = path.join(root, 'replica-a');
    process.env.APP_JWT_SECRET = 'replica-a-seed-that-is-longer-than-32-characters';
    process.env.TWO_FACTOR_ENCRYPTION_KEY = 'replica-a-2fa-seed-longer-than-32-characters';
    const config = { get: (name, fallback = '') => process.env[name] ?? fallback };
    const first = new SecurityMaterialService(database, config);
    await first.initialize();

    process.env.KEYS_DIR = path.join(root, 'replica-b');
    process.env.APP_JWT_SECRET = 'replica-b-different-seed-longer-than-32-characters';
    process.env.TWO_FACTOR_ENCRYPTION_KEY = 'replica-b-different-2fa-seed-over-32-characters';
    const second = new SecurityMaterialService(database, config);
    await second.initialize();

    assert.equal(second.userJwtSecret(), first.userJwtSecret());
    assert.deepEqual(second.twoFactorKey(), first.twoFactorKey());
    assert.deepEqual(second.certificateBundle(), first.certificateBundle());
    assert.equal(
      fs.readFileSync(path.join(root, 'replica-b', 'ca.crt'), 'utf8'),
      first.certificateBundle().caCertificate.toString('utf8'),
    );
    console.log('shared security material replica test: PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    restore('KEYS_DIR', previous.keysDir);
    restore('APP_JWT_SECRET', previous.jwt);
    restore('TWO_FACTOR_ENCRYPTION_KEY', previous.twoFactor);
  }
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
