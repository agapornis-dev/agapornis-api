export function normalizeServerStatus(value: unknown) {
  const status = String(value || 'unknown').trim().toLowerCase();
  return status === 'exited' ? 'offline' : status;
}
