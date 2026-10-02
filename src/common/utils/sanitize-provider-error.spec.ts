import { sanitizeProviderError, redactAccountNumbers } from './sanitize-provider-error';

/**
 * SYS-B-503 — pesan error mentah provider tidak boleh membawa PII
 * (nomor rekening) ke kolom DB `lastError` / respons user. Yang disimpan
 * hanya kode generik; detail mentah hanya ke log internal teredaksi.
 */
describe('sanitizeProviderError (SYS-B-503)', () => {
  it('meredaksi nomor rekening (digit 8+) dari detail log', () => {
    const raw = new Error(
      'DANA API error: Beneficiary account 1234567890 not found at bank 014',
    );
    const s = sanitizeProviderError(raw);
    expect(s.detailForLog).not.toContain('1234567890');
    expect(s.detailForLog).toContain('****');
    // Kode bank 3 digit bukan PII — boleh tetap ada.
    expect(s.detailForLog).toContain('014');
  });

  it('kode generik untuk kegagalan bisnis provider (tanpa PII di code)', () => {
    const s = sanitizeProviderError('Invalid beneficiary account 9876543210987654');
    expect(s.code).toBe('PROVIDER_REQUEST_FAILED');
    expect(s.detailForLog).not.toMatch(/\d{8,}/);
  });

  it('mengenali timeout sebagai PROVIDER_TIMEOUT', () => {
    const s = sanitizeProviderError(new Error('Request ETIMEDOUT after 20000ms'));
    expect(s.code).toBe('PROVIDER_TIMEOUT');
  });

  it('mengenali kegagalan jaringan sebagai PROVIDER_NETWORK_ERROR', () => {
    const s = sanitizeProviderError(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    expect(s.code).toBe('PROVIDER_NETWORK_ERROR');
  });

  it('menerima string mentah (bukan hanya Error)', () => {
    const s = sanitizeProviderError('DANA responseMessage: rekening 1122334455 diblokir');
    expect(s.code).toBe('PROVIDER_REQUEST_FAILED');
    expect(s.detailForLog).not.toContain('1122334455');
  });

  it('aman untuk input kosong/undefined', () => {
    expect(sanitizeProviderError(undefined).code).toBe('PROVIDER_REQUEST_FAILED');
    expect(sanitizeProviderError(null).detailForLog).toBe('');
  });

  it('detailForLog dibatasi 2000 karakter', () => {
    const s = sanitizeProviderError('x'.repeat(5000));
    expect(s.detailForLog.length).toBeLessThanOrEqual(2000);
  });
});

describe('redactAccountNumbers', () => {
  it('digit < 8 tidak disensor (kode bank, responseCode)', () => {
    expect(redactAccountNumbers('bank 014 code 4001001')).toBe('bank 014 code 4001001');
  });

  it('semua rangkaian digit 8+ disensor', () => {
    expect(redactAccountNumbers('a 12345678 b 1234567890123456')).toBe('a **** b ****');
  });
});
