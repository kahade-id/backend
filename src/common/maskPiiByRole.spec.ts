/**
 * GAP-E (G376–G400) — unit test helper penyamaran PII per role admin.
 */
import { maskEmail, maskPhone, maskIp, applyUserMask, PII_UNMASKED_ROLES } from './maskPiiByRole';

describe('common/maskPiiByRole', () => {
  describe('maskEmail', () => {
    it('menyamarkan local-part dan domain, TLD dipertahankan', () => {
      expect(maskEmail('budi.santoso@example.co.id')).toBe('b•@e••.co.id');
    });

    it('mengembalikan null untuk null/undefined', () => {
      expect(maskEmail(null)).toBeNull();
      expect(maskEmail(undefined)).toBeNull();
    });

    it('menyamarkan penuh alamat tanpa @', () => {
      expect(maskEmail('bukan-email')).toBe('•••');
    });
  });

  describe('maskPhone', () => {
    it('mempertahankan kode negara + 2 digit terakhir', () => {
      expect(maskPhone('+6281234567890')).toBe('+62•••••••••90');
    });

    it('mengembalikan null untuk null/undefined', () => {
      expect(maskPhone(null)).toBeNull();
      expect(maskPhone(undefined)).toBeNull();
    });

    it('menyamarkan penuh nomor sangat pendek', () => {
      expect(maskPhone('123')).toBe('•••');
    });
  });

  describe('applyUserMask', () => {
    const user = { id: 'u1', email: 'budi@example.com', phoneNumber: '+6281234567890' };

    it('SUPER_ADMIN melihat PII penuh', () => {
      const result = applyUserMask('SUPER_ADMIN', user);
      expect(result).toBe(user);
      expect(result.email).toBe('budi@example.com');
      expect(result.phoneNumber).toBe('+6281234567890');
    });

    it.each(['CUSTOMER_SUPPORT', 'KYC_ADMIN', 'FINANCE_ADMIN', 'DISPUTE_ADMIN'])(
      'menyamarkan email & nomor untuk role %s',
      (role) => {
        const masked = applyUserMask(role, user);
        expect(masked).not.toBe(user);
        expect(masked.email).not.toBe(user.email);
        expect(masked.phoneNumber).not.toBe(user.phoneNumber);
        expect(masked.email).toContain('@');
      },
    );

    it('fail-closed untuk role tak dikenal / null / undefined', () => {
      for (const role of ['RANDOM_ROLE', null, undefined, '']) {
        const masked = applyUserMask(role, user);
        expect(masked.email).not.toBe(user.email);
        expect(masked.phoneNumber).not.toBe(user.phoneNumber);
      }
    });

    it('tidak mengubah field non-PII', () => {
      const masked = applyUserMask('CUSTOMER_SUPPORT', user);
      expect(masked.id).toBe('u1');
    });

    it('allowlist eksplisit hanya berisi SUPER_ADMIN', () => {
      expect([...PII_UNMASKED_ROLES]).toEqual(['SUPER_ADMIN']);
    });
  });

  describe('maskIp (BAI-076)', () => {
    it('menyamarkan IPv4, hanya oktet pertama dipertahankan', () => {
      expect(maskIp('36.81.123.45')).toBe('36.••.••.••');
    });

    it('menyamarkan IPv6, hanya hextet pertama dipertahankan', () => {
      const masked = maskIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
      expect(masked).toBe('2001:••••');
      expect(masked).not.toContain('0db8');
    });

    it('meneruskan null/undefined sebagai null', () => {
      expect(maskIp(null)).toBeNull();
      expect(maskIp(undefined)).toBeNull();
    });

    it('mengembalikan null untuk string kosong/blank', () => {
      expect(maskIp('')).toBeNull();
      expect(maskIp('   ')).toBeNull();
    });

    it('menyamarkan penuh input yang bukan IP valid', () => {
      expect(maskIp('not-an-ip')).toBe('••••');
      expect(maskIp('1.2.3')).toBe('••••');
    });

    it('memangkas whitespace sebelum masking', () => {
      expect(maskIp('  10.0.0.1  ')).toBe('10.••.••.••');
    });
  });
});
