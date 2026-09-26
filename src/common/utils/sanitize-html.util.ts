/**
 * Sanitasi HTML allowlist untuk deskripsi etalase Kahade+ (Benefit 7).
 *
 * Mirror dari frontend `lib/showcase-html.ts` (`sanitizeShowcaseHtml`) —
 * backend WAJIB mensanitasi sebelum menyimpan; frontend tidak boleh menjadi
 * satu-satunya garis pertahanan (stored XSS via client lain).
 *
 * Tag yang diizinkan: p, br, b, strong, i, em, u, s, ul, ol, li, a, blockquote.
 * Atribut: hanya `href` pada <a>, dan hanya http(s). Event handler (on*),
 * <style>, <script>, <iframe>, <object>, <embed>, komentar HTML, dan semua
 * tag lain dihapus (isi teksnya dipertahankan).
 *
 * Idempoten: menjalankan dua kali tidak merusak hasil.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
]);

/** Panjang maksimum HTML mentah yang diproses — pelindung DoS regex. */
const MAX_HTML_LENGTH = 50_000;

function stripDangerousBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object\s*>/gi, '')
    .replace(/<(embed|link|meta|base|form|input|button|video|audio|source|track)\b[^>]*\/?>/gi, '');
}

/** Ambil href yang aman (http/https saja) dari atribut tag <a>. */
function safeHref(attrs: string): string | undefined {
  const match = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const raw = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  return undefined;
}

export function sanitizeShowcaseHtml(html: string): string {
  if (typeof html !== 'string') return '';
  let input = html.length > MAX_HTML_LENGTH ? html.slice(0, MAX_HTML_LENGTH) : html;
  input = stripDangerousBlocks(input);
  // Hapus event handler & atribut style di semua tag yang tersisa.
  input = input.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  input = input.replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  const out: string[] = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  for (;;) {
    match = tagRe.exec(input);
    if (!match) break;
    out.push(input.slice(last, match.index));
    last = match.index + match[0].length;
    const name = match[1].toLowerCase();
    const isClose = match[0][1] === '/';
    if (!ALLOWED_TAGS.has(name)) continue; // tag tak dikenal: buang tag, simpan isi
    if (name === 'br') {
      out.push('<br>');
      continue;
    }
    if (name === 'a' && !isClose) {
      const href = safeHref(match[2]);
      out.push(href ? `<a href="${href}">` : '<a>');
      continue;
    }
    out.push(isClose ? `</${name}>` : `<${name}>`);
  }
  out.push(input.slice(last));
  return out.join('');
}
