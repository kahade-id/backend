import { isLoopbackInternalProbe } from '../internal-readiness.util';

describe('isLoopbackInternalProbe', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts direct loopback source %s without a forwarded chain', (remoteAddress) => {
    expect(isLoopbackInternalProbe(remoteAddress, {})).toBe(true);
  });

  it('rejects a proxy-forwarded request even when the socket peer is local', () => {
    expect(isLoopbackInternalProbe('127.0.0.1', { 'x-forwarded-for': '203.0.113.10' })).toBe(false);
  });

  it('rejects a non-loopback source without relying on caller-provided headers', () => {
    expect(isLoopbackInternalProbe('10.0.0.5', {})).toBe(false);
  });
});
