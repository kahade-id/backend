/**
 * Deployment readiness is intentionally transport-bound rather than secret-bound.
 * The API port is firewall-private and Nginx always sends X-Forwarded-For for
 * public traffic, so a direct loopback request without that header can only be
 * made by a local server process.
 */
export function isLoopbackInternalProbe(
  remoteAddress: string | undefined,
  headers: { 'x-forwarded-for'?: string | string[] | undefined },
): boolean {
  const forwardedFor = headers['x-forwarded-for'];
  const hasForwardedChain = Array.isArray(forwardedFor)
    ? forwardedFor.some((value) => value.trim().length > 0)
    : typeof forwardedFor === 'string' && forwardedFor.trim().length > 0;

  if (hasForwardedChain) return false;
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
}
