/**
 * Chat content moderation — Trust & Safety primitives for the escrow chat.
 *
 * Why this exists
 * ---------------
 * Kahade's entire value proposition is that the money sits in escrow until both
 * parties are satisfied. The moment buyer and seller move the conversation (and
 * the payment) off-platform, escrow protection silently evaporates and Kahade
 * is left with a support ticket it cannot act on. Off-platform circumvention is
 * therefore not a UX nuisance — it is the single largest business risk in the
 * chat surface.
 *
 * Everything in this file is a pure function: no I/O, no Prisma, no config
 * imports. That keeps the detector unit-testable (evasion techniques are the
 * interesting test cases) and lets the service layer decide what to persist.
 *
 * Design notes
 * ------------
 * - Matching runs against *folded* views of the text, not the raw string, so
 *   that common obfuscation ("wa. me", "0 8 1 2", "n0l d3l4p4n", "a.n.j.i.n.g")
 *   is still caught. Every folded character carries the index of the original
 *   character it came from, so matches map back and can be redacted in place.
 * - Word matching is token-based, not substring-based. Substring matching is
 *   unusable in Bahasa Indonesia: "tai" (shit) is inside "santai" (relax) and
 *   "detail", and "tele" is inside "telepon" (telephone). A naive substring
 *   filter would censor ordinary conversation and erode trust in the feature.
 * - Every matcher declares its own severity and action. The caller aggregates:
 *   BLOCK wins over REDACT, REDACT wins over FLAG.
 */

export type ChatModerationKind = 'CIRCUMVENTION' | 'CONTACT_SHARING' | 'PROFANITY' | 'SPAM';

export type ChatModerationSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ChatModerationAction = 'BLOCKED' | 'REDACTED' | 'FLAGGED';

export interface ModerationMatch {
  /** Stable matcher id — persisted so the moderation queue can be filtered. */
  matcher: string;
  kind: ChatModerationKind;
  severity: ChatModerationSeverity;
  /** What the service layer should do for this single match. */
  action: ChatModerationAction;
  /** Indonesian, user-facing explanation (safe to return in the API response). */
  reason: string;
  /** Half-open interval [start, end) in the ORIGINAL text. */
  start: number;
  end: number;
  /** The matched slice of the original text — for the moderation queue only. */
  snippet: string;
  /**
   * Matcher ids of overlapping matches folded into this one. Overlaps are
   * collapsed so redaction never masks the same range twice, but the audit
   * trail keeps every matcher that fired.
   */
  absorbedMatchers?: string[];
}

export interface ModerationVerdict {
  /** The text after redaction (unchanged when nothing was redacted). */
  text: string;
  matches: ModerationMatch[];
  /** True when at least one match requires the message to be rejected. */
  blocked: boolean;
  /** True when content was masked in place. */
  redacted: boolean;
  /** True when the message is allowed but should be reviewed. */
  flagged: boolean;
  maxSeverity: ChatModerationSeverity | null;
  /** Top-priority block reason, ready to drop into an error response. */
  blockReason: string | null;
  blockMatcher: string | null;
  /** Kinds that fired — cheap rollup for metrics/logging. */
  kinds: ChatModerationKind[];
}

// ============================================================
// Folding
// ============================================================

interface Folded {
  text: string;
  /** map[i] = index in the ORIGINAL string of folded character i. */
  map: number[];
}

/**
 * Characters that render as nothing and are the cheapest way to break a naive
 * regex: "wa<ZWSP>.me", "0812<ZWSP>345" — keduanya lolos dari regex
 * biasa, tapi tidak dari fold di bawah.
 */
const INVISIBLE = new Set([
  0x00ad, // soft hyphen
  0x180e, // mongolian vowel separator
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0x2060, // word joiner
  0xfeff, // BOM / zero width no-break space
]);

/** Punctuation people insert to split a word or a number. */
const SEPARATOR_CHARS = new Set(' \t\r\n.,;:\'"`!?()[]{}<>/\\|-_+=*#~^&%$');

/** Leetspeak used to spell *words* (handles, profanity, brand names). */
const LEET_DIGIT_TO_LETTER: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '2': 'z',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'g',
  '7': 't',
  '8': 'b',
  '9': 'g',
  $: 's',
  '+': 't',
};

/**
 * Deliberately NOT applied: a per-character letter→digit map. It looks clever
 * for catching "0Satu2", but it maps ordinary prose into digits
 * ("tolong transfer" → "70109…") and produces a stream of fictional 12+ digit
 * runs that drown the moderation queue in noise. Spoken number words are
 * handled explicitly instead (see NUMBER_WORDS).
 */

/**
 * Bahasa Indonesia number words. Reading a number out loud ("nol delapan satu
 * dua tiga …") is the most common way to dodge a phone regex in Indonesian chat.
 */
const NUMBER_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['sepuluh', '10'],
  ['delapan', '8'],
  ['sembilan', '9'],
  ['kosong', '0'],
  ['empat', '4'],
  ['tujuh', '7'],
  ['enam', '6'],
  ['lima', '5'],
  ['satu', '1'],
  ['tiga', '3'],
  ['dua', '2'],
  ['nol', '0'],
];

const NUMBER_WORD_RE = new RegExp(`(${NUMBER_WORDS.map(([word]) => word).join('|')})`, 'gi');
const NUMBER_WORD_VALUE = new Map(NUMBER_WORDS);

function identityFolded(source: string): Folded {
  const map: number[] = new Array(source.length);
  for (let i = 0; i < source.length; i++) map[i] = i;
  return { text: source, map };
}

function foldMapped(source: Folded, transform: (ch: string) => string | null): Folded {
  const out: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < source.text.length; i++) {
    const replacement = transform(source.text[i]);
    if (replacement === null) continue;
    for (const ch of replacement) {
      out.push(ch);
      map.push(source.map[i]);
    }
  }
  return { text: out.join(''), map };
}

/** Replace spoken number words with digits, preserving the index map. */
function applyNumberWords(source: Folded): Folded {
  const text = source.text;
  const out: string[] = [];
  const map: number[] = [];
  let last = 0;
  NUMBER_WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBER_WORD_RE.exec(text)) !== null) {
    while (last < match.index) {
      out.push(text[last]);
      map.push(source.map[last]);
      last++;
    }
    const digits = NUMBER_WORD_VALUE.get(match[0].toLowerCase()) ?? '';
    for (const digit of digits) {
      out.push(digit);
      map.push(source.map[match.index]);
    }
    last = match.index + match[0].length;
  }
  while (last < text.length) {
    out.push(text[last]);
    map.push(source.map[last]);
    last++;
  }
  return { text: out.join(''), map };
}

/** Collapse "anjiiing" → "anjing" while leaving legitimate doubles ("maaf") alone. */
function collapseRuns(value: string): string {
  return value.replace(/(.)\1{2,}/g, '$1');
}

/**
 * Alphabetic view: lowercased, invisible characters and separators dropped,
 * leetspeak digits restored to letters, runs of 3+ characters collapsed.
 * Used for multi-word phrase detection ("di luar aplikasi" → "diluaraplikasi").
 */
function foldAlpha(raw: string): Folded {
  const lower = collapseRuns(raw.toLowerCase().normalize('NFKC'));
  const withNumbers = applyNumberWords(identityFolded(lower));
  return foldMapped(withNumbers, ch => {
    if (INVISIBLE.has(ch.codePointAt(0) ?? 0)) return null;
    if (SEPARATOR_CHARS.has(ch)) return null;
    return LEET_DIGIT_TO_LETTER[ch] ?? ch;
  });
}

/**
 * Link view: raw punctuation preserved (domains need their dots) but invisible
 * characters and all whitespace removed, so "w a . m e", "W4.ME" and "wa.me"
 * all fold to "wa.me".
 */
function foldLink(raw: string): Folded {
  const lower = raw.toLowerCase().normalize('NFKC');
  return foldMapped(identityFolded(lower), ch => {
    if (INVISIBLE.has(ch.codePointAt(0) ?? 0)) return null;
    if (/\s/.test(ch)) return null;
    return LEET_DIGIT_TO_LETTER[ch] ?? ch;
  });
}

/**
 * Numeric view: digits only (plus a leading '+') after spoken number words
 * have been converted and invisible/separator characters removed — so
 * "0 8 1 2 3 4" and "0812-3456" both fold to the same digit stream. This is
 * what the phone and long-number matchers run against.
 */
function foldDigits(raw: string): Folded {
  const lower = raw.toLowerCase().normalize('NFKC');
  const withNumbers = applyNumberWords(identityFolded(lower));
  const compacted = foldMapped(withNumbers, ch => {
    if (INVISIBLE.has(ch.codePointAt(0) ?? 0)) return null;
    if (SEPARATOR_CHARS.has(ch)) return null;
    return ch;
  });
  return foldMapped(compacted, ch => (/\d/.test(ch) || ch === '+' ? ch : null));
}

interface RawToken {
  /** Normalized token (leet-folded, runs collapsed). */
  value: string;
  start: number;
  end: number;
}

function tokenize(raw: string): RawToken[] {
  const tokens: RawToken[] = [];
  const re = /[a-z0-9@$.+-]+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const slice = match[0];
    let value = '';
    for (const ch of slice) {
      if (INVISIBLE.has(ch.codePointAt(0) ?? 0)) continue;
      value += LEET_DIGIT_TO_LETTER[ch] ?? ch;
    }
    value = collapseRuns(value.toLowerCase());
    if (!value) continue;
    tokens.push({ value, start: match.index, end: match.index + slice.length });
  }
  return tokens;
}

// ============================================================
// Word lists
// ============================================================

/**
 * Two profanity tiers so mild slang is only logged while genuine slurs are
 * masked. Kept small on purpose: a 2000-word list is unreviewable, and every
 * extra entry is another chance to censor a legitimate Bahasa Indonesia word.
 */
const PROFANITY_SEVERE: ReadonlyArray<string> = [
  // Bahasa Indonesia
  'anjing',
  'anjg',
  'anying',
  'anjrit',
  'bangsat',
  'bgsat',
  'bajingan',
  'keparat',
  'brengsek',
  'brngsek',
  'kampret',
  'jancok',
  'jancuk',
  'cukimay',
  'goblok',
  'goblog',
  'gblk',
  'tolol',
  'bloon',
  'bego',
  'begu',
  'bodoh',
  'ngentot',
  'entot',
  'memek',
  'kontol',
  'titit',
  'pepek',
  'perek',
  'jembut',
  'sundal',
  'lonte',
  'pelacur',
  'bangke',
  'tai',
  // English
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'bastard',
  'asshole',
  'dickhead',
  'whore',
  'slut',
  'pussy',
  'motherfucker',
];

const PROFANITY_MILD: ReadonlyArray<string> = [
  'anjir',
  'anjay',
  'anjayy',
  'setan',
  'sialan',
  'kampungan',
  'gobloknya',
  'damn',
  'hell',
];

/**
 * Substring matching is only safe for entries long enough that they cannot be
 * a slice of an ordinary word. "tai" is in "santai"; "anjing" is not in
 * anything innocent, so the ≥6 rule keeps precision without losing recall on
 * the words that matter.
 */
const PROFANITY_SUBSTRING_MIN_LENGTH = 6;

/**
 * Channel names that are unambiguous on their own, matched as whole tokens.
 * "tele" is safe here even though it is a prefix of "telepon", because token
 * matching only fires on the standalone word.
 */
const SOCIAL_TOKENS_STRONG: ReadonlyArray<string> = [
  'whatsapp',
  'whatshapp',
  'whatsap',
  'watsapp',
  'wechat',
  'wechatid',
  'telegram',
  'telegramid',
  'tele',
  'messenger',
  'discord',
  'signal',
  'viber',
  'instagram',
  'facebook',
];

/**
 * Two- and three-letter abbreviations that DO have innocent readings in
 * Bahasa Indonesia: "wa" is also the Arabic conjunction in the greeting
 * "wa'alaikumussalam", "line"/"ig"/"pm"/"dm" are ordinary English words.
 * These only fire when they sit next to contact vocabulary ("wa saya",
 * "add line", "pm aja"), which is how people actually share them.
 */
const SOCIAL_TOKENS_NEEDING_CONTEXT: ReadonlyArray<string> = ['wa', 'line', 'ig', 'pm', 'dm'];

const CONTACT_CONTEXT_TOKENS: ReadonlyArray<string> = [
  'saya',
  'aku',
  'gue',
  'gua',
  'no',
  'nomor',
  'nomer',
  'nmr',
  'add',
  'added',
  'chat',
  'hubungi',
  'hub',
  'kontak',
  'contact',
  'kirim',
  'id',
  'punya',
  'nya',
  'ku',
  'mu',
  'kamu',
  'anda',
  'aja',
  'saja',
  'ya',
  'dong',
  'aja ya',
];

/**
 * Phrases that either name an off-platform channel outright or state the
 * intent to transact outside escrow. Written without separators because the
 * alphabetic fold strips them: "di luar aplikasi" → "diluaraplikasi".
 */
const OFF_PLATFORM_CRITICAL: ReadonlyArray<string> = [
  'lanjutdiwa',
  'lanjutdiwhatsapp',
  'pindahkewa',
  'pindahkewhatsapp',
  'pindahketelegram',
  'lanjutditelegram',
  'chatiwa',
  'chatdiwhatsapp',
  'chataluaraplikasi',
  'chataluarapp',
  'hubungidiwa',
  'hubungiditelegram',
  'kontaksayadiwa',
  'kontakdiwa',
  'addwa',
  'addline',
  'chatdiluarsini',
  'diluaraplikasi',
  'diluarapps',
  'diluarapp',
  'diluarkahade',
  'luaraplikasi',
  'luarapps',
  'luarapp',
  'luarkahade',
  'offapp',
  'offtheapp',
  'outsideapp',
  'outsidetheapp',
  'outsidekahade',
  'offlineaja',
  'offlinesaja',
  'dealdiluar',
  'bayardiluar',
  'tfkeluar',
];

const OFF_PLATFORM_INTENT: ReadonlyArray<string> = [
  'tanpaescrow',
  'tanpakahade',
  'gakusihlewataplikasi',
  'gausahlewataplikasi',
  'gakperlulewataplikasi',
  'tidakusahlewataplikasi',
  'tanpalewataplikasi',
  'tanpalewatapp',
  'lewatinkahade',
  'lewatiaplikasi',
  'lewatinaplikasi',
  'hindarifee',
  'hindaribiayaadmin',
  'biargakkenafee',
  'biargakenafee',
  'agargakkenafee',
  'supayagakkenafee',
  'nggakmaubayarfee',
  'skipfee',
  'tanpafee',
  'tanpabiayaadmin',
  'bebasfee',
  'transaksilangsung',
  'transferlangsung',
  'tflangsung',
  'bayarlangsung',
  'tfkeluarsistem',
  'tanpapihakketiga',
  'tanpapengawasan',
  'tanpapihakketigaaja',
];

/** Ambiguous on their own — logged for review, never blocked. */
const OFF_PLATFORM_AMBIGUOUS: ReadonlyArray<string> = [
  'cod',
  'codan',
  'ketemuan',
  'ketemuaja',
  'temuanaja',
  'cashondelivery',
  'nomorsaya',
  'nohpsaya',
  'kontaksaya',
  'pmsaya',
  'japri',
  'japriaja',
  'privataja',
  'nonekspedisi',
];

/**
 * Currency-ish tokens. A phone-shaped number sitting next to one of these is
 * far more likely to be an amount than a contact, so the verdict is downgraded
 * to a flag instead of a block. Note the deliberate exclusion of "transfer" /
 * "bayar" / "tf": those are *actions*, and "transfer ke 0812…" is exactly the
 * circumvention case we must keep blocking.
 */
const AMOUNT_MARKERS: ReadonlyArray<string> = [
  'rp',
  'rupiah',
  'ribu',
  'juta',
  'harga',
  'total',
  'nominal',
  'biaya',
  'ongkir',
  'saldo',
  'tagihan',
  'diskon',
  'kembalian',
  'sudah include',
];

/** Blocked outright: asking for credentials/OTP in chat is always a scam. */
const SCAM_PATTERNS_CRITICAL: ReadonlyArray<string> = [
  'kodeotp',
  'mintaotp',
  'kirimotp',
  'kodeverifikasi',
  'mintakode',
  'kirimkode',
  'koderahasia',
  'kodeaktivasi',
  'kodeaktifasi',
  'passwordakun',
  'passwordsaya',
  'pinwallet',
  'mintapin',
  'kirimpin',
];

/** Flagged: classic bait. Wrong in a payment chat, but not actionable alone. */
const SCAM_PATTERNS_SUSPICIOUS: ReadonlyArray<string> = [
  'menangundian',
  'undianberhadiah',
  'hadiahgratis',
  'kliklink',
  'linkberhadiah',
  'transferdulubarudikirim',
  'transferdulu',
  'kirimdulu',
  'danaganda',
  'gabunggrup',
  'joingrup',
  'profitpasif',
  'cuanpasti',
  'dijaminuntung',
];

const URL_SHORTENERS: ReadonlyArray<string> = [
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'is.gd',
  'rb.gy',
  'cutt.ly',
  'shorturl.at',
  's.id',
  'lynk.id',
  'linktr.ee',
  'buff.ly',
  'ow.ly',
];

const MESSAGING_HOSTS: ReadonlyArray<string> = [
  'wa.me',
  'wa.link',
  'api.whatsapp.com',
  'chat.whatsapp.com',
  'web.whatsapp.com',
  'whatsapp.com',
  't.me',
  'telegram.me',
  'telegram.dog',
  'm.me',
  'messenger.com',
  'line.me',
  'discord.gg',
  'signal.group',
];

// ============================================================
// Matchers
// ============================================================

interface MatcherContext {
  raw: string;
  alpha: Folded;
  link: Folded;
  digits: Folded;
  tokens: RawToken[];
}

type Matcher = (ctx: MatcherContext) => ModerationMatch[];

type MatchBase = Omit<ModerationMatch, 'start' | 'end' | 'snippet'>;

function pushFromFolded(
  out: ModerationMatch[],
  folded: Folded,
  start: number,
  end: number,
  base: MatchBase,
  raw: string,
): void {
  const from = folded.map[start];
  const to = folded.map[end - 1] + 1;
  if (from === undefined || to === undefined) return;
  out.push({ ...base, start: from, end: to, snippet: raw.slice(from, to) });
}

/** Substring scan over a folded view. */
function findPhrases(
  ctx: MatcherContext,
  folded: Folded,
  phrases: ReadonlyArray<string>,
  base: MatchBase,
): ModerationMatch[] {
  const out: ModerationMatch[] = [];
  for (const phrase of phrases) {
    let from = 0;
    for (;;) {
      const idx = folded.text.indexOf(phrase, from);
      if (idx === -1) break;
      pushFromFolded(out, folded, idx, idx + phrase.length, base, ctx.raw);
      from = idx + phrase.length;
    }
  }
  return out;
}

/** Whole-token scan — immune to the "santai"/"telepon" class of false positive. */
function findTokens(
  ctx: MatcherContext,
  words: ReadonlyArray<string>,
  base: MatchBase,
): ModerationMatch[] {
  const set = new Set(words);
  const out: ModerationMatch[] = [];
  for (const token of ctx.tokens) {
    if (!set.has(token.value)) continue;
    out.push({
      ...base,
      start: token.start,
      end: token.end,
      snippet: ctx.raw.slice(token.start, token.end),
    });
  }
  return out;
}

/**
 * Token scan that additionally requires a neighbouring token from `context`.
 * Used for abbreviations that legitimately appear in ordinary conversation.
 */
function findTokensWithContext(
  ctx: MatcherContext,
  words: ReadonlyArray<string>,
  context: ReadonlyArray<string>,
  base: MatchBase,
): ModerationMatch[] {
  const wanted = new Set(words);
  const neighbours = new Set(context);
  const out: ModerationMatch[] = [];
  ctx.tokens.forEach((token, index) => {
    if (!wanted.has(token.value)) return;
    const previous = ctx.tokens[index - 1]?.value;
    const next = ctx.tokens[index + 1]?.value;
    if ((previous && neighbours.has(previous)) || (next && neighbours.has(next))) {
      out.push({
        ...base,
        start: token.start,
        end: token.end,
        snippet: ctx.raw.slice(token.start, token.end),
      });
    }
  });
  return out;
}

function runGlobal(
  ctx: MatcherContext,
  folded: Folded,
  re: RegExp,
  base: MatchBase,
): ModerationMatch[] {
  const out: ModerationMatch[] = [];
  const regex = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(folded.text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    pushFromFolded(out, folded, match.index, match.index + match[0].length, base, ctx.raw);
  }
  return out;
}

/**
 * True when a number sits next to currency vocabulary. Uses the RAW text
 * window (indexes already align) so the check stays cheap and predictable.
 */
function contextHasAmountMarker(ctx: MatcherContext, start: number, end: number): boolean {
  const window = ctx.raw
    .slice(Math.max(0, start - 18), Math.min(ctx.raw.length, end + 8))
    .toLowerCase();
  return AMOUNT_MARKERS.some(marker => window.includes(marker));
}

const phoneMatcher: Matcher = ctx => {
  const out: ModerationMatch[] = [];
  // Indonesian mobile numbers: 08xx… (10–13 digits) or (+62|62) 8xx…
  const re = /(?:\+?62|0)8[1-9]\d{7,11}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(ctx.digits.text)) !== null) {
    const start = ctx.digits.map[match.index];
    const end = ctx.digits.map[match.index + match[0].length - 1] + 1;
    if (start === undefined || end === undefined) continue;
    const amountLike = contextHasAmountMarker(ctx, start, end);
    out.push({
      matcher: 'PHONE_NUMBER',
      kind: 'CIRCUMVENTION',
      severity: amountLike ? 'MEDIUM' : 'HIGH',
      action: amountLike ? 'FLAGGED' : 'BLOCKED',
      reason:
        'Nomor telepon tidak boleh dibagikan di chat. Semua komunikasi harus tetap di dalam Kahade agar transaksi terlindungi escrow.',
      start,
      end,
      snippet: ctx.raw.slice(start, end),
    });
  }
  return out;
};

const bankAccountMatcher: Matcher = ctx => {
  const out: ModerationMatch[] = [];
  const re = /\d{12,16}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(ctx.digits.text)) !== null) {
    const start = ctx.digits.map[match.index];
    const end = ctx.digits.map[match.index + match[0].length - 1] + 1;
    if (start === undefined || end === undefined) continue;
    if (contextHasAmountMarker(ctx, start, end)) continue;
    out.push({
      matcher: 'LONG_NUMBER',
      kind: 'CONTACT_SHARING',
      severity: 'LOW',
      action: 'FLAGGED',
      reason:
        'Deretan angka panjang terdeteksi — pastikan ini bukan nomor rekening atau data kontak pribadi.',
      start,
      end,
      snippet: ctx.raw.slice(start, end),
    });
  }
  return out;
};

const messagingLinkMatcher: Matcher = ctx =>
  findPhrases(ctx, ctx.link, MESSAGING_HOSTS, {
    matcher: 'OFF_PLATFORM_LINK',
    kind: 'CIRCUMVENTION',
    severity: 'CRITICAL',
    action: 'BLOCKED',
    reason:
      'Tautan ke aplikasi obrolan eksternal diblokir. Transaksi di luar Kahade tidak dilindungi escrow.',
  });

const shortenerMatcher: Matcher = ctx =>
  findPhrases(ctx, ctx.link, URL_SHORTENERS, {
    matcher: 'URL_SHORTENER',
    kind: 'SPAM',
    severity: 'MEDIUM',
    action: 'FLAGGED',
    reason:
      'Tautan pendek terdeteksi. Tim Kahade meninjau pesan ini karena tautan pendek sering dipakai untuk menyembunyikan tujuan asli.',
  });

const socialWordBase: MatchBase = {
  matcher: 'OFF_PLATFORM_CHANNEL_WORD',
  kind: 'CIRCUMVENTION',
  severity: 'HIGH',
  action: 'BLOCKED',
  reason:
    'Menyebut kanal komunikasi di luar Kahade dapat menghilangkan perlindungan escrow. Mohon lanjutkan percakapan di dalam aplikasi.',
};

const socialWordMatcher: Matcher = ctx => [
  ...findTokens(ctx, SOCIAL_TOKENS_STRONG, socialWordBase),
  ...findTokensWithContext(
    ctx,
    SOCIAL_TOKENS_NEEDING_CONTEXT,
    CONTACT_CONTEXT_TOKENS,
    socialWordBase,
  ),
];

const emailMatcher: Matcher = ctx =>
  runGlobal(ctx, ctx.link, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/, {
    matcher: 'EMAIL',
    kind: 'CONTACT_SHARING',
    severity: 'MEDIUM',
    action: 'FLAGGED',
    reason:
      'Alamat email terdeteksi. Tim Kahade meninjau pesan ini untuk memastikan komunikasi tetap berada di dalam aplikasi.',
  });

const handleMatcher: Matcher = ctx =>
  runGlobal(ctx, ctx.link, /@[a-z0-9_]{4,32}/, {
    matcher: 'SOCIAL_HANDLE',
    kind: 'CONTACT_SHARING',
    severity: 'LOW',
    action: 'FLAGGED',
    reason: 'Username/handle terdeteksi. Tim Kahade meninjau pesan ini.',
  });

const offPlatformCriticalMatcher: Matcher = ctx =>
  findPhrases(ctx, ctx.alpha, OFF_PLATFORM_CRITICAL, {
    matcher: 'OFF_PLATFORM_PHRASE',
    kind: 'CIRCUMVENTION',
    severity: 'CRITICAL',
    action: 'BLOCKED',
    reason:
      'Ajakan melanjutkan transaksi di luar aplikasi diblokir. Transaksi di luar Kahade tidak dilindungi escrow dan tidak bisa dibantu jika terjadi masalah.',
  });

const offPlatformIntentMatcher: Matcher = ctx =>
  findPhrases(ctx, ctx.alpha, OFF_PLATFORM_INTENT, {
    matcher: 'ESCROW_BYPASS_INTENT',
    kind: 'CIRCUMVENTION',
    severity: 'HIGH',
    action: 'BLOCKED',
    reason:
      'Pesan ini terbaca sebagai ajakan melewati escrow. Semua pembayaran harus lewat Kahade agar dana dan barang terlindungi.',
  });

const offPlatformAmbiguousMatcher: Matcher = ctx =>
  findTokens(ctx, OFF_PLATFORM_AMBIGUOUS, {
    matcher: 'OFF_PLATFORM_AMBIGUOUS',
    kind: 'CIRCUMVENTION',
    severity: 'LOW',
    action: 'FLAGGED',
    reason:
      'Pesan ini menyebut pola yang kadang dipakai untuk transaksi di luar aplikasi. Tim Kahade akan meninjaunya.',
  });

const scamCriticalMatcher: Matcher = ctx =>
  findPhrases(ctx, ctx.alpha, SCAM_PATTERNS_CRITICAL, {
    matcher: 'CREDENTIAL_PHISHING',
    kind: 'SPAM',
    severity: 'CRITICAL',
    action: 'BLOCKED',
    reason:
      'Meminta kode OTP, PIN, atau password di chat adalah pola penipuan. Kahade tidak pernah meminta data tersebut lewat chat.',
  });

const scamSuspiciousMatcher: Matcher = ctx =>
  findPhrases(ctx, ctx.alpha, SCAM_PATTERNS_SUSPICIOUS, {
    matcher: 'SCAM_PATTERN',
    kind: 'SPAM',
    severity: 'MEDIUM',
    action: 'FLAGGED',
    reason:
      'Pesan ini memiliki pola yang sering dipakai penipuan. Tetap gunakan alur pembayaran Kahade.',
  });

const profanityTokenMatcher: Matcher = ctx => [
  ...findTokens(ctx, PROFANITY_SEVERE, {
    matcher: 'PROFANITY',
    kind: 'PROFANITY',
    severity: 'MEDIUM',
    action: 'REDACTED',
    reason: 'Kata tidak pantas disensor otomatis.',
  }),
  ...findTokens(ctx, PROFANITY_MILD, {
    matcher: 'PROFANITY_MILD',
    kind: 'PROFANITY',
    severity: 'LOW',
    action: 'FLAGGED',
    reason: 'Bahasa kasar ringan terdeteksi.',
  }),
];

/**
 * Catches the punctuated form ("a.n.j.i.n.g") that tokenization would split
 * into single letters. Restricted to long entries so it cannot censor "santai".
 */
const profanityPhraseMatcher: Matcher = ctx =>
  findPhrases(
    ctx,
    ctx.alpha,
    PROFANITY_SEVERE.filter(word => word.length >= PROFANITY_SUBSTRING_MIN_LENGTH),
    {
      matcher: 'PROFANITY',
      kind: 'PROFANITY',
      severity: 'MEDIUM',
      action: 'REDACTED',
      reason: 'Kata tidak pantas disensor otomatis.',
    },
  );

const externalLinkMatcher: Matcher = ctx => {
  const out: ModerationMatch[] = [];
  const re = /https?:\/\/[^\s]+|(?:www\.)[a-z0-9.-]+\.[a-z]{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(ctx.link.text)) !== null) {
    const start = ctx.link.map[match.index];
    const end = ctx.link.map[match.index + match[0].length - 1] + 1;
    if (start === undefined || end === undefined) continue;
    const isTrusted = match[0].includes('kahade');
    out.push({
      matcher: isTrusted ? 'KAHADE_LINK' : 'EXTERNAL_LINK',
      kind: 'SPAM',
      severity: isTrusted ? 'LOW' : 'MEDIUM',
      action: 'FLAGGED',
      reason: isTrusted
        ? 'Tautan internal Kahade.'
        : 'Tautan eksternal terdeteksi. Tim Kahade meninjau pesan ini.',
      start,
      end,
      snippet: ctx.raw.slice(start, end),
    });
  }
  return out;
};

const noisyMessageMatcher: Matcher = ctx => {
  const out: ModerationMatch[] = [];
  const letters = ctx.raw.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 25) {
    const upper = ctx.raw.replace(/[^A-Z]/g, '').length;
    if (upper / letters.length > 0.7) {
      out.push({
        matcher: 'SHOUTING',
        kind: 'SPAM',
        severity: 'LOW',
        action: 'FLAGGED',
        reason: 'Pesan menggunakan huruf kapital berlebihan.',
        start: 0,
        end: ctx.raw.length,
        snippet: ctx.raw.slice(0, 80),
      });
    }
  }
  const repeated = /(.)\1{11,}/.exec(ctx.raw);
  if (repeated) {
    out.push({
      matcher: 'CHARACTER_SPAM',
      kind: 'SPAM',
      severity: 'LOW',
      action: 'FLAGGED',
      reason: 'Pesan berisi pengulangan karakter berlebihan.',
      start: repeated.index,
      end: repeated.index + repeated[0].length,
      snippet: ctx.raw.slice(repeated.index, repeated.index + repeated[0].length),
    });
  }
  return out;
};

const CIRCUMVENTION_MATCHERS: ReadonlyArray<Matcher> = [
  messagingLinkMatcher,
  offPlatformCriticalMatcher,
  socialWordMatcher,
  offPlatformIntentMatcher,
  phoneMatcher,
  offPlatformAmbiguousMatcher,
];

const FULL_MATCHERS: ReadonlyArray<Matcher> = [
  ...CIRCUMVENTION_MATCHERS,
  scamCriticalMatcher,
  emailMatcher,
  handleMatcher,
  scamSuspiciousMatcher,
  shortenerMatcher,
  externalLinkMatcher,
  bankAccountMatcher,
  profanityTokenMatcher,
  profanityPhraseMatcher,
  noisyMessageMatcher,
];

// ============================================================
// Public API
// ============================================================

const SEVERITY_RANK: Record<ChatModerationSeverity, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const ACTION_RANK: Record<ChatModerationAction, number> = {
  FLAGGED: 1,
  REDACTED: 2,
  BLOCKED: 3,
};

export interface ModerateOptions {
  /**
   * Downgrade every match to at most this action. Lets operations soft-launch
   * the filter (or disable hard blocking entirely) without a deploy.
   */
  maxAction?: ChatModerationAction;
  /** Only look for off-platform circumvention — used for file names. */
  circumventionOnly?: boolean;
}

/** Merge overlapping spans so redaction never applies twice to the same range. */
function mergeMatches(matches: ModerationMatch[]): ModerationMatch[] {
  const sorted = [...matches].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end;
  });
  const merged: ModerationMatch[] = [];
  for (const match of sorted) {
    const last = merged[merged.length - 1];
    if (last && match.start < last.end) {
      const stronger =
        ACTION_RANK[match.action] > ACTION_RANK[last.action] ||
        (match.action === last.action &&
          SEVERITY_RANK[match.severity] > SEVERITY_RANK[last.severity]);
      const kept = stronger ? match : last;
      const dropped = stronger ? last : match;
      merged[merged.length - 1] = {
        ...kept,
        start: last.start,
        end: Math.max(last.end, match.end),
        absorbedMatchers: [
          ...(kept.absorbedMatchers ?? []),
          dropped.matcher,
          ...(dropped.absorbedMatchers ?? []),
        ],
      };
      continue;
    }
    merged.push({ ...match });
  }
  return merged;
}

function maskSpan(snippet: string): string {
  if (snippet.length <= 1) return '*';
  if (snippet.length <= 4) return `${snippet[0]}${'*'.repeat(snippet.length - 1)}`;
  return `${snippet[0]}${'*'.repeat(Math.min(snippet.length - 2, 8))}${snippet[snippet.length - 1]}`;
}

/**
 * Run every detector against `raw` and return the verdict plus the (possibly
 * redacted) text. Pure: the caller decides whether to persist, emit or reject.
 */
export function moderateText(raw: string, options: ModerateOptions = {}): ModerationVerdict {
  const empty: ModerationVerdict = {
    text: raw ?? '',
    matches: [],
    blocked: false,
    redacted: false,
    flagged: false,
    maxSeverity: null,
    blockReason: null,
    blockMatcher: null,
    kinds: [],
  };
  if (!raw) return empty;

  const ctx: MatcherContext = {
    raw,
    alpha: foldAlpha(raw),
    link: foldLink(raw),
    digits: foldDigits(raw),
    tokens: tokenize(raw),
  };

  const collected: ModerationMatch[] = [];
  for (const matcher of options.circumventionOnly ? CIRCUMVENTION_MATCHERS : FULL_MATCHERS) {
    collected.push(...matcher(ctx));
  }

  const matches = mergeMatches(collected);
  if (matches.length === 0) return empty;

  const ceiling = options.maxAction ?? 'BLOCKED';
  const effective = matches.map(match =>
    ACTION_RANK[match.action] > ACTION_RANK[ceiling] ? { ...match, action: ceiling } : match,
  );

  const blocked = effective.find(match => match.action === 'BLOCKED') ?? null;
  const redactable = effective.filter(match => match.action === 'REDACTED');

  let text = raw;
  if (!blocked && redactable.length > 0) {
    let cursor = 0;
    let output = '';
    for (const match of redactable) {
      if (match.start < cursor) continue;
      output += raw.slice(cursor, match.start) + maskSpan(raw.slice(match.start, match.end));
      cursor = match.end;
    }
    output += raw.slice(cursor);
    text = output;
  }

  const kinds = [...new Set(effective.map(m => m.kind))];
  const maxSeverity = effective.reduce<ChatModerationSeverity | null>((acc, match) => {
    if (!acc || SEVERITY_RANK[match.severity] > SEVERITY_RANK[acc]) return match.severity;
    return acc;
  }, null);

  return {
    text,
    matches: effective,
    blocked: blocked !== null,
    redacted: blocked === null && redactable.length > 0,
    flagged: effective.some(m => m.action === 'FLAGGED'),
    maxSeverity,
    blockReason: blocked?.reason ?? null,
    blockMatcher: blocked?.matcher ?? null,
    kinds,
  };
}

/**
 * Attachment file names are user-controlled text rendered inside the chat
 * bubble ("Bukti-transfer-0812xxxx.pdf"), so they get scanned too. Rejecting
 * an upload over a file name is hostile, so the ceiling here is REDACTED: the
 * name is masked and the event is logged rather than blocked.
 */
export function moderateFileName(raw: string): ModerationVerdict {
  return moderateText(raw, { maxAction: 'REDACTED', circumventionOnly: true });
}
