/**
 * Kahade — uji unit observability Grup F (G479/G482/G491/G493/G494).
 *
 * Mencakup logika murni tanpa DB/Redis:
 * - withSpan: menolak atribut objek (anti payload mentah), merekam span
 *   error 100%, sampling sukses.
 * - MetricsService: normalisasi path (tanpa ID mentah di label), p95.
 * - ErrorSpikeTracker: jendela geser.
 * - recordDeliveryMetric/getDeliveryStats: agregat tanpa PII.
 * - wsOnConnect/wsOnDisconnect/getWsSnapshot: counter + reconnect per versi.
 */
import {
  withSpan,
  getSpanBuffer,
  getSamplingStats,
} from '../../common/tracing/tracing';
import { MetricsService, ErrorSpikeTracker } from './metrics.service';
import {
  recordDeliveryMetric,
  getDeliveryStats,
} from './delivery-metrics.service';
import {
  wsOnConnect,
  wsOnDisconnect,
  getWsSnapshot,
} from './ws-metrics.service';

describe('withSpan (G479/G480/G481)', () => {
  it('menolak atribut bertipe objek agar payload mentah tidak masuk span', async () => {
    await expect(
      withSpan('payment.webhook', async () => undefined, {
        raw: { secret: 'x' } as unknown as string,
      }),
    ).rejects.toThrow(/must be a scalar/);
  });

  it('merekam span error 100% dengan nama error saja (tanpa message/stack)', async () => {
    const before = getSpanBuffer().length;
    await expect(
      withSpan('order.create', async () => {
        throw new TypeError('kredensial user 0812xxxx bocor?');
      }),
    ).rejects.toThrow(TypeError);
    const spans = getSpanBuffer().slice(before);
    expect(spans.length).toBe(1);
    expect(spans[0].status).toBe('error');
    expect(spans[0].errorName).toBe('TypeError');
    // Message mentah TIDAK disimpan di span.
    expect(JSON.stringify(spans[0])).not.toContain('bocor');
  });

  it('span sukses membawa requestId + atribut skalar aman', async () => {
    const before = getSpanBuffer().length;
    // Paksa sampling lolos dengan mengulang hingga tercatat (maks 500x).
    let recorded = false;
    for (let i = 0; i < 500 && !recorded; i++) {
      await withSpan('upload.direct', async () => 'ok', {
        size: 1234,
        mime: 'image/jpeg',
      });
      recorded = getSpanBuffer().length > before;
    }
    expect(recorded).toBe(true);
    const stats = getSamplingStats();
    expect(stats.successSampleRate).toBe(0.01);
  });
});

describe('MetricsService (G482)', () => {
  it('menormalisasi path param mentah menjadi :id', () => {
    const svc = new MetricsService();
    svc.recordRequest(
      '/v1/orders/550e8400-e29b-41d4-a716-446655440000/items',
      'GET',
      200,
      42,
    );
    const stats = svc.getRouteStats();
    expect(stats.length).toBe(1);
    expect(stats[0].route).toBe('GET /v1/orders/:id/items');
    expect(stats[0].route).not.toContain('550e8400');
  });

  it('menghitung p95 dari sampel', () => {
    const svc = new MetricsService();
    for (let i = 1; i <= 100; i++) {
      svc.recordRequest('/v1/wallet/balance', 'GET', 200, i);
    }
    const [s] = svc.getRouteStats();
    expect(s.count).toBe(100);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
    expect(s.p50).toBe(50);
  });

  it('mengabaikan route di luar prefix kunci', () => {
    const svc = new MetricsService();
    svc.recordRequest('/v1/showcase/feed', 'GET', 200, 10);
    expect(svc.getRouteStats()).toHaveLength(0);
  });
});

describe('ErrorSpikeTracker (G485)', () => {
  it('menghitung event dalam jendela geser dan memangkas yang tua', () => {
    const tracker = new ErrorSpikeTracker();
    const now = Date.now();
    tracker.record('login', now - 10 * 60 * 1000); // di luar jendela 5 mnt
    tracker.record('login', now - 60 * 1000);
    tracker.record('login', now - 30 * 1000);
    expect(tracker.countSince('login', 5 * 60 * 1000, now)).toBe(2);
  });
});

describe('delivery metrics (G494)', () => {
  it('mengagregat counter per channel:provider tanpa payload', () => {
    recordDeliveryMetric('push', 'expo', 'sent', 3);
    recordDeliveryMetric('push', 'expo', 'failed', 1);
    recordDeliveryMetric('otp', 'fonnte', 'sent', 2);
    const stats = getDeliveryStats();
    const expo = stats.find((s) => s.channel === 'push' && s.provider === 'expo');
    expect(expo?.sent).toBeGreaterThanOrEqual(3);
    expect(expo?.failed).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(stats)).not.toContain('08');
  });
});

describe('ws metrics (G493)', () => {
  it('mencatat connect/disconnect dan reconnect per versi app', () => {
    const snap0 = getWsSnapshot();
    wsOnConnect('sock-1', 'user-1', '1.2.3');
    wsOnDisconnect('sock-1', 'user-1');
    // Connect lagi dalam 60 detik → reconnect.
    wsOnConnect('sock-2', 'user-1', '1.2.3');
    const snap = getWsSnapshot();
    expect(snap.totalConnects).toBe(snap0.totalConnects + 2);
    expect(snap.reconnectsByAppVersion['1.2.3']).toBe(
      (snap0.reconnectsByAppVersion['1.2.3'] ?? 0) + 1,
    );
    wsOnDisconnect('sock-2', 'user-1');
  });

  it('menormalisasi versi aneh menjadi unknown', () => {
    const snap0 = getWsSnapshot();
    wsOnConnect('sock-x', undefined, 'not a version!!!');
    const snap = getWsSnapshot();
    expect(snap.connectsByAppVersion['unknown']).toBe(
      (snap0.connectsByAppVersion['unknown'] ?? 0) + 1,
    );
    wsOnDisconnect('sock-x', undefined);
  });
});
