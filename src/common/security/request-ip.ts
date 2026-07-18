/**
 * Fastify's request.ip already applies the configured trustProxy policy.
 * Reading X-Forwarded-For directly would let an untrusted client spoof the
 * identity used by bans, rate limits, and audit records.
 */
export function trustedRequestIp(request: any): string | undefined {
  const value = request?.ip || request?.socket?.remoteAddress;
  const ip = String(value || '').trim();
  return ip || undefined;
}
