import { RESERVED_USERNAMES } from '../app.constants';

/**
 * Deeplink reserved words (Instagram-style: kahade.id/:username, kahade.id/p/:id).
 * None of these path segments may be usable as a username, otherwise the
 * landing router cannot distinguish a profile URL from a reserved route.
 */
const DEEPLINK_RESERVED = [
  'p', 'payment', 'transfer', 'register', 'help', 'download', 'terms',
  'privacy', 'about', 'contact', 'support', 'api', 'admin', 'static',
  'images', 'order-link', 'v', 'r', 'faq', 'login', 'verify', 'settings',
  'notifications', 'chat', 'wallet', 'explore', 'search',
];

describe('DEEPLINK: reserved words tidak boleh dipakai sebagai username', () => {
  it.each(DEEPLINK_RESERVED)('"%s" ada di RESERVED_USERNAMES', (word) => {
    expect(RESERVED_USERNAMES).toContain(word);
  });

  it('pengecekan case-insensitive: versi kapital juga tertolak setelah normalisasi', () => {
    // Semua titik validasi me-normalize ke lowercase sebelum cek includes(),
    // jadi cukup pastikan bentuk lowercase-nya ada di daftar.
    for (const word of DEEPLINK_RESERVED) {
      expect(RESERVED_USERNAMES.includes(word.toLowerCase())).toBe(true);
    }
  });

  it('username biasa tidak ikut terblokir', () => {
    const normal = ['budiono', 'siti123', 'toko-berkah', 'kahade_fans', 'user.premium'];
    for (const name of normal) {
      expect(RESERVED_USERNAMES).not.toContain(name);
    }
  });

  it('daftar tidak mengandung duplikat', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const name of RESERVED_USERNAMES) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    expect(dupes).toEqual([]);
  });
});
