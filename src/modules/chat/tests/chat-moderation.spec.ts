import { moderateText, moderateFileName, ModerationVerdict } from '../chat-moderation.util';

/** Every matcher that fired, including ones folded into an overlapping match. */
function allMatchers(verdict: ModerationVerdict): string[] {
  return verdict.matches.flatMap(m => [m.matcher, ...(m.absorbedMatchers ?? [])]);
}

/**
 * The detector only earns its keep if it is hard to evade AND quiet on ordinary
 * Indonesian conversation. Both halves are tested here: every "allows" case is
 * a real sentence a buyer or seller would plausibly type.
 */

describe('chat moderation — circumvention detection (blocking)', () => {
  it('BLOCKS a wa.me link', () => {
    const verdict = moderateText('oke, cek wa.me/6281234567890 ya');
    expect(verdict.blocked).toBe(true);
    expect(allMatchers(verdict)).toContain('OFF_PLATFORM_LINK');
  });

  it('BLOCKS a t.me telegram link', () => {
    expect(moderateText('join sini https://t.me/joinchat/AAAA').blocked).toBe(true);
  });

  it('BLOCKS a bare Indonesian mobile number', () => {
    const verdict = moderateText('nomor saya 081234567890');
    expect(verdict.blocked).toBe(true);
    expect(allMatchers(verdict)).toContain('PHONE_NUMBER');
  });

  it('BLOCKS a number in +62 international format', () => {
    expect(moderateText('hubungi +6281234567890').blocked).toBe(true);
  });

  it('BLOCKS a number padded with separators', () => {
    expect(moderateText('no hp: 0812-3456-7890').blocked).toBe(true);
  });

  it('BLOCKS a number spelled out in Indonesian words', () => {
    const verdict = moderateText(
      'ini nomorku nol delapan satu dua tiga empat lima enam tujuh delapan',
    );
    expect(verdict.blocked).toBe(true);
    expect(allMatchers(verdict)).toContain('PHONE_NUMBER');
  });

  it('BLOCKS a number split by invisible characters', () => {
    expect(moderateText('tlp 0812​3456​7890 ya', { maxAction: 'BLOCKED' }).blocked).toBe(true);
  });

  it('BLOCKS an explicit off-platform invitation', () => {
    const verdict = moderateText('mending kita lanjut di luar aplikasi aja, biar cepet');
    expect(verdict.blocked).toBe(true);
    expect(allMatchers(verdict)).toContain('OFF_PLATFORM_PHRASE');
  });

  it('BLOCKS escrow-bypass intent', () => {
    const verdict = moderateText('transfer langsung aja ke saya, gak usah lewat aplikasi');
    expect(verdict.blocked).toBe(true);
    expect(allMatchers(verdict)).toContain('ESCROW_BYPASS_INTENT');
  });

  it('BLOCKS "tanpa escrow" phrasing', () => {
    expect(moderateText('gimana kalau tanpa escrow aja?')).toMatchObject({ blocked: true });
  });

  it('BLOCKS a channel abbreviation with contact context ("wa saya")', () => {
    expect(moderateText('ini wa saya, chat aja nanti')).toMatchObject({ blocked: true });
  });

  it('BLOCKS an OTP phishing attempt', () => {
    const verdict = moderateText('boleh minta kode OTP yang baru masuk? buat verifikasi');
    expect(verdict.blocked).toBe(true);
    expect(allMatchers(verdict)).toContain('CREDENTIAL_PHISHING');
  });
});

describe('chat moderation — ordinary Indonesian conversation (must NOT block)', () => {
  const allowed = [
    'barang sudah ready kak, santai aja',
    'detail pesanan sudah saya kirim ya',
    'tolong telepon kurir kalau tidak di rumah',
    'harga total Rp 850.000 sudah termasuk ongkir',
    'besok saya kirim resi JNE ya',
    'mohon maaf kak, lagi ada acara keluarga',
    'Waalaikumussalam warahmatullahi wabarakatuh kak',
    "wa'alaikumsalam, orderannya sudah saya proses",
    'paketnya pakai kardus tebal supaya aman',
    'transfer ke rekening BCA atas nama toko kami',
    'sudah saya cek, barangnya original 100%',
    'nomor resi: JP0123456789, bisa dicek di website JNE',
    'mantap, lanjut order ya kak',
    'oke fix, tunggu barangnya datang',
  ];

  it.each(allowed)('ALLOWS "%s"', text => {
    const verdict = moderateText(text);
    expect(verdict.blocked).toBe(false);
  });

  it('does NOT redact ordinary words that contain a profanity substring', () => {
    // "santai" contains "tai", "detail" contains "tai" — token matching must
    // keep both intact, otherwise the filter censors everyday Bahasa Indonesia.
    const verdict = moderateText('santai aja kak, detailnya nanti saya kabarin');
    expect(verdict.redacted).toBe(false);
    expect(verdict.text).toBe('santai aja kak, detailnya nanti saya kabarin');
  });
});

describe('chat moderation — redaction', () => {
  it('REDACTS severe profanity but keeps the message', () => {
    const verdict = moderateText('dasar anjing, barangnya palsu!');
    expect(verdict.blocked).toBe(false);
    expect(verdict.redacted).toBe(true);
    expect(verdict.text).not.toContain('anjing');
    expect(verdict.text).toContain('dasar');
  });

  it('REDACTS punctuation-separated profanity', () => {
    const verdict = moderateText('a.n.j.i.n.g lu');
    expect(verdict.redacted).toBe(true);
  });

  it('REDACTS stretched profanity ("anjiiing")', () => {
    expect(moderateText('anjiiing keren banget')).toMatchObject({ redacted: true });
  });

  it('does NOT redact mild slang, only flags it', () => {
    const verdict = moderateText('anjir, mahal banget');
    expect(verdict.redacted).toBe(false);
    expect(verdict.flagged).toBe(true);
    expect(verdict.text).toBe('anjir, mahal banget');
  });
});

describe('chat moderation — flagging', () => {
  it('FLAGS an email address without blocking it', () => {
    const verdict = moderateText('kirim invoice ke budi@contoh.com ya');
    expect(verdict.blocked).toBe(false);
    expect(verdict.flagged).toBe(true);
    expect(allMatchers(verdict)).toContain('EMAIL');
  });

  it('FLAGS a URL shortener', () => {
    expect(moderateText('cek https://s.id/abc123')).toMatchObject({
      flagged: true,
      blocked: false,
    });
  });

  it('FLAGS ambiguous COD / meet-up phrasing instead of blocking', () => {
    const verdict = moderateText('bisa COD aja gak?');
    expect(verdict.blocked).toBe(false);
    expect(verdict.flagged).toBe(true);
  });

  it('FLAGS a long digit run that is not a mobile number', () => {
    const verdict = moderateText('nomor rekening 12345678901234');
    expect(allMatchers(verdict)).toContain('LONG_NUMBER');
  });

  it('DOWNGRADES a number next to currency vocabulary to a flag', () => {
    const verdict = moderateText('totalnya 081234567890 rupiah');
    // Still recorded (a human should look), but not silently rejected.
    expect(verdict.blocked).toBe(false);
    expect(verdict.flagged).toBe(true);
  });
});

describe('chat moderation — severity and rolling out gradually', () => {
  it('reports the highest severity and the blocking reason', () => {
    const verdict = moderateText('lanjut di wa.me/628111 ya');
    expect(verdict.maxSeverity).toBe('CRITICAL');
    expect(verdict.blockReason).toBeTruthy();
    // Two CRITICAL matchers overlap here ("lanjut di wa" and the wa.me host);
    // the audit trail must keep both, not just the surviving span.
    expect(allMatchers(verdict)).toEqual(
      expect.arrayContaining(['OFF_PLATFORM_LINK', 'OFF_PLATFORM_PHRASE']),
    );
  });

  it('honours maxAction so operations can soft-launch', () => {
    const verdict = moderateText('ini nomor saya 081234567890', { maxAction: 'FLAGGED' });
    expect(verdict.blocked).toBe(false);
    expect(verdict.flagged).toBe(true);
    expect(verdict.text).toBe('ini nomor saya 081234567890');
  });

  it('returns an empty verdict for an empty message', () => {
    expect(moderateText('')).toMatchObject({ matches: [], blocked: false, flagged: false });
  });
});

describe('chat moderation — attachment file names', () => {
  it('REDACTS a phone number embedded in a file name instead of rejecting the upload', () => {
    const verdict = moderateFileName('bukti-transfer-081234567890.pdf');
    expect(verdict.blocked).toBe(false);
    expect(verdict.redacted).toBe(true);
    expect(verdict.text).not.toContain('081234567890');
  });

  it('leaves an ordinary file name untouched', () => {
    const verdict = moderateFileName('foto-barang-depan.jpg');
    expect(verdict.matches).toHaveLength(0);
    expect(verdict.text).toBe('foto-barang-depan.jpg');
  });
});
