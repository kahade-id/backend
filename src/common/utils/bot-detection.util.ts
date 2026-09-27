/**
 * Deteksi user-agent crawler/bot umum.
 *
 * Dipakai untuk metrik "aksi nyata" (share/view): pembukaan oleh bot (preview
 * OG, indexer, unfurl chat) BUKAN interaksi manusia → tidak boleh menaikkan
 * counter seperti shareCount (SH-B-004/SH-S-002).
 *
 * Catatan: UA mudah dipalsukan — ini lapisan anti-noise, bukan kontrol
 * keamanan. Dedupe per-viewer (Redis SET NX) tetap menjadi pertahanan utama.
 */
const BOT_UA_RE =
  /bot|crawl|spider|slurp|mediapartners|baidu|yandex|facebookexternalhit|twitterbot|linkedinbot|embedly|quora|pinterest|slackbot|discordbot|telegrambot|whatsapp|google-inspection-tool/i;

/** True bila user-agent cocok pola crawler/bot umum. UA kosong dianggap manusia
 * (konsisten dengan perilaku deep-links sebelumnya) — jangan under-count. */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? '').trim();
  return ua.length > 0 && BOT_UA_RE.test(ua);
}
