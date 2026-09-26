/**
 * CN-008 — timezone helper untuk quiet hours.
 */
import { normalizeTimezone, getMinutesInTimezone, isMinutesInRange, DEFAULT_QUIET_HOURS_TIMEZONE } from './timezone.util';

describe('timezone.util (CN-008)', () => {
  describe('normalizeTimezone', () => {
    it('menerima IANA timezone valid', () => {
      expect(normalizeTimezone('Asia/Jakarta')).toBe('Asia/Jakarta');
      expect(normalizeTimezone('Asia/Makassar')).toBe('Asia/Makassar');
      expect(normalizeTimezone('Asia/Jayapura')).toBe('Asia/Jayapura');
    });
    it('menolak nilai invalid', () => {
      expect(normalizeTimezone('WIB')).toBeNull();
      expect(normalizeTimezone('')).toBeNull();
      expect(normalizeTimezone(null)).toBeNull();
      expect(normalizeTimezone(undefined)).toBeNull();
      expect(normalizeTimezone(7)).toBeNull();
    });
  });

  describe('getMinutesInTimezone', () => {
    // 2026-09-26T00:00:00Z = 07:00 WIB, 08:00 WITA, 09:00 WIT
    const utcMidnight = new Date('2026-09-26T00:00:00.000Z');
    it('menghitung menit dengan benar per zona waktu', () => {
      expect(getMinutesInTimezone(utcMidnight, 'Asia/Jakarta')).toBe(7 * 60);
      expect(getMinutesInTimezone(utcMidnight, 'Asia/Makassar')).toBe(8 * 60);
      expect(getMinutesInTimezone(utcMidnight, 'Asia/Jayapura')).toBe(9 * 60);
    });
    it('fallback ke Asia/Jakarta bila timezone invalid/kosong', () => {
      expect(getMinutesInTimezone(utcMidnight, 'WIB')).toBe(7 * 60);
      expect(getMinutesInTimezone(utcMidnight, null)).toBe(7 * 60);
      expect(getMinutesInTimezone(utcMidnight, undefined)).toBe(7 * 60);
    });
    it('default constant adalah Asia/Jakarta (perilaku lama)', () => {
      expect(DEFAULT_QUIET_HOURS_TIMEZONE).toBe('Asia/Jakarta');
    });
  });

  describe('isMinutesInRange', () => {
    it('rentang normal', () => {
      expect(isMinutesInRange(23 * 60, '22:00', '23:59')).toBe(true);
      expect(isMinutesInRange(21 * 60, '22:00', '23:59')).toBe(false);
    });
    it('rentang overnight', () => {
      expect(isMinutesInRange(23 * 60, '22:00', '07:00')).toBe(true);
      expect(isMinutesInRange(3 * 60, '22:00', '07:00')).toBe(true);
      expect(isMinutesInRange(12 * 60, '22:00', '07:00')).toBe(false);
    });
    it('batas eksklusif di akhir', () => {
      expect(isMinutesInRange(7 * 60, '22:00', '07:00')).toBe(false);
      expect(isMinutesInRange(22 * 60, '22:00', '07:00')).toBe(true);
    });
  });
});
