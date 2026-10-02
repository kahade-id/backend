import { appSchemeUrl } from './deep-links.controller';

/**
 * SYS-C-401 (audit sistemik ronde 3, 2026-10-03): test kontrak — setiap URL
 * skema `kahade://` yang dihasilkan backend HARUS menunjuk ke route
 * expo-router FE yang benar-benar ada. Head pendek (u/, o-l/, o/, n/,
 * email-verified) jatuh ke +not-found ("Tautan tidak tersedia").
 *
 * Rute FE yang ada (frontend/app/):
 *   user/[username].tsx, order-link/[token].tsx, order/[id].tsx,
 *   notification/[id].tsx, verify-email.tsx, showcase/[id].tsx,
 *   tracking/[shipmentId].tsx
 */
const KNOWN_FE_ROUTE_HEADS = new Set([
  'user',
  'order-link',
  'order',
  'notification',
  'verify-email',
  'showcase',
  'tracking',
]);

function headOf(appUrl: string): string {
  const withoutScheme = appUrl.replace(/^kahade:\/\//, '');
  return withoutScheme.split('/')[0]!;
}

describe('appSchemeUrl (kontrak deep link)', () => {
  const cases: Array<[string, string]> = [
    ['user/invalid', 'profil'],
    ['user/someone', 'profil valid'],
    ['order-link/invalid', 'order-link'],
    ['order-link/abc123', 'order-link valid'],
    ['order/invalid', 'order'],
    ['order/ord_1', 'order valid'],
    ['notification/invalid', 'notifikasi'],
    ['notification/notif_1', 'notifikasi valid'],
    ['verify-email', 'verifikasi email'],
    ['showcase/invalid', 'showcase'],
    ['tracking/invalid', 'tracking'],
  ];

  it.each(cases)('path "%s" (%s) menunjuk ke route FE yang ada', (path) => {
    const url = appSchemeUrl(path);
    expect(url).toBe(`kahade://${path}`);
    expect(KNOWN_FE_ROUTE_HEADS.has(headOf(url))).toBe(true);
  });

  it('head pendek yang mati TIDAK boleh dipakai lagi', () => {
    const deadHeads = ['u/', 'o-l/', 'o/', 'n/', 'email-verified'];
    for (const head of deadHeads) {
      // tidak ada lagi pemanggilan appSchemeUrl dengan head pendek —
      // verifikasi lewat daftar hitam head yang dikenal FE
      expect(KNOWN_FE_ROUTE_HEADS.has(head.replace(/\/$/, ''))).toBe(false);
    }
  });
});
