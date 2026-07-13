require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { BadRequestException, ServiceUnavailableException } = require('@nestjs/common');
const { CertificateService } = require('../src/modules/agents/certificate.service');
const { NodeUnavailableError } = require('../src/modules/agents/certificate-rotation.service');

async function main() {
  const invalidated = [];
  const client = { invalidateNode: nodeId => invalidated.push(nodeId) };

  const service = new CertificateService(
    {
      activatePendingCertificate: async nodeId => ({ nodeId, certificateFingerprint: 'next' }),
      revokeCertificate: async nodeId => ({ nodeId, certificateRevokedAt: 'now' }),
    },
    client,
    { rotate: async nodeId => ({ nodeId, rotated: true }) },
  );

  assert.equal((await service.rotate('node-1')).rotated, true);
  assert.equal((await service.activate('node-1')).agent.certificateFingerprint, 'next');
  assert.equal((await service.revoke('node-1')).agent.certificateRevokedAt, 'now');
  assert.deepEqual(invalidated, ['node-1', 'node-1']);

  const unavailable = new CertificateService({}, client, {
    rotate: async () => {
      throw new NodeUnavailableError('node-2', 'node-2:5001');
    },
  });
  await assert.rejects(() => unavailable.rotate('node-2'), ServiceUnavailableException);

  const activationFailure = new CertificateService(
    { activatePendingCertificate: async () => { throw new Error('node has no pending certificate'); } },
    client,
    { rotate: async () => ({}) },
  );
  await assert.rejects(() => activationFailure.activate('node-3'), BadRequestException);

  console.log('certificate operation rule tests: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
