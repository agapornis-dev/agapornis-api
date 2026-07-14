import { createHash } from 'crypto';

export const TOKEN_DIGEST_ALGORITHM = 'sha3-512' as const;
const LEGACY_TOKEN_DIGEST_ALGORITHM = 'sha256';

export function tokenDigest(value: string) {
  return createHash(TOKEN_DIGEST_ALGORITHM).update(String(value)).digest('hex');
}

/**
 * New secrets are stored with SHA3-512. The legacy digest remains a read-only
 * candidate so short-lived tokens issued before an upgrade can still be used.
 */
export function tokenDigestCandidates(value: string) {
  const normalized = String(value);
  return [
    tokenDigest(normalized),
    createHash(LEGACY_TOKEN_DIGEST_ALGORITHM).update(normalized).digest('hex'),
  ];
}
