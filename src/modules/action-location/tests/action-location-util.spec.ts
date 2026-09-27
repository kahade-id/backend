import { extractLocationContext } from '../action-location.util';

// Unit test helper konteks lokasi controller → service.
describe('extractLocationContext', () => {
  const loc = { latitude: -6.2, longitude: 106.85 };

  it('mengambil ip dari req.ip dan deviceId dari header X-Device-Id', () => {
    const ctx = extractLocationContext(
      { ip: '203.0.113.10', headers: { 'x-device-id': 'dev-abc' } } as any,
      { deviceLocation: loc },
    );
    expect(ctx).toEqual({ location: loc, ipAddress: '203.0.113.10', deviceId: 'dev-abc' });
  });

  it('fallback ke socket.remoteAddress lalu "unknown"', () => {
    const ctx = extractLocationContext(
      { ip: undefined, socket: { remoteAddress: '::1' }, headers: {} } as any,
      {},
    );
    expect(ctx.ipAddress).toBe('::1');
    expect(ctx.location).toBeNull();
    expect(ctx.deviceId).toBeUndefined();

    const ctx2 = extractLocationContext({ headers: {} } as any);
    expect(ctx2.ipAddress).toBe('unknown');
  });

  it('deviceLocation null/absent → location null (user menolak GPS)', () => {
    const ctx = extractLocationContext({ ip: '1.2.3.4', headers: {} } as any, { deviceLocation: null });
    expect(ctx.location).toBeNull();
  });
});
