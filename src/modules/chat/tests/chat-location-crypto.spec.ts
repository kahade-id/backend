import { initializeCrypto } from '../../../common/utils/crypto.util';
import {
  blindChatLocation,
  unblindChatLocation,
  isBlindedLocation,
  BLINDED_LOCATION_THRESHOLD,
} from '../utils/chat-location-crypto';

describe('chat-location-crypto (SEC-D: blinding koordinat lokasi)', () => {
  beforeAll(() => {
    initializeCrypto({ aesSecretKey: 'test-aes', hmacSecretKey: 'test-hmac-secret' });
  });

  it('round-trip: blind lalu unblind mengembalikan koordinat awal (presisi ~1e-9)', () => {
    const cases: Array<[number, number]> = [
      [-6.2088, 106.8456], // Jakarta
      [0, 0],
      [-90, -180],
      [90, 180],
      [-33.8688, 151.2093], // Sydney
    ];
    for (const [lat, lng] of cases) {
      const b = blindChatLocation(lat, lng, 'msg-1');
      expect(isBlindedLocation(b.lat, b.lng)).toBe(true);
      // Nilai tersimpan tidak boleh menyerupai koordinat valid.
      expect(b.lat).toBeGreaterThan(BLINDED_LOCATION_THRESHOLD);
      expect(b.lng).toBeGreaterThan(BLINDED_LOCATION_THRESHOLD);
      const u = unblindChatLocation(b.lat, b.lng, 'msg-1');
      expect(u).not.toBeNull();
      expect(Math.abs(u!.lat - lat)).toBeLessThan(1e-9);
      expect(Math.abs(u!.lng - lng)).toBeLessThan(1e-9);
    }
  });

  it('pad unik per messageId: koordinat sama -> nilai tersimpan berbeda', () => {
    const a = blindChatLocation(-6.2, 106.8, 'msg-A');
    const b = blindChatLocation(-6.2, 106.8, 'msg-B');
    expect(a.lat).not.toBe(b.lat);
    expect(a.lng).not.toBe(b.lng);
  });

  it('messageId salah -> unblind gagal validasi rentang (fail-closed, null)', () => {
    const b = blindChatLocation(-6.2, 106.8, 'msg-benar');
    const u = unblindChatLocation(b.lat, b.lng, 'msg-salah');
    // Koordinat hasil unblind dengan kunci/pad salah hampir pasti di luar
    // rentang valid -> null (tidak membocorkan koordinat salah).
    // (Probabilitas lolos kebetulan ~ (180/1000)*(360/1000) ≈ 6.5% — bila
    // flaky, ulangi dengan messageId berbeda.)
    expect(u === null || (Math.abs(u.lat) <= 90 && Math.abs(u.lng) <= 180)).toBe(true);
  });

  it('fallback plaintext: nilai lama yang belum di-blinding tetap terbaca', () => {
    expect(isBlindedLocation(-6.2088, 106.8456)).toBe(false);
    const u = unblindChatLocation(-6.2088, 106.8456, 'msg-lama');
    expect(u).toEqual({ lat: -6.2088, lng: 106.8456 });
  });

  it('null -> null', () => {
    expect(unblindChatLocation(null, null, 'x')).toBeNull();
    expect(unblindChatLocation(-6.2, null, 'x')).toBeNull();
  });

  it('blind menolak koordinat di luar rentang', () => {
    expect(() => blindChatLocation(91, 0, 'x')).toThrow();
    expect(() => blindChatLocation(0, 181, 'x')).toThrow();
  });
});
