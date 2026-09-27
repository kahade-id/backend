/**
 * GAP-F (G434): alat redaksi PII di teks Q&A.
 *
 * Mendeteksi pola nomor HP Indonesia, email, NIK (16 digit), dan nomor
 * rekening bank, lalu menggantinya dengan placeholder. Versi teredaksi
 * disimpan di kolom `redacted_text`; teks original TIDAK pernah diubah (audit).
 */

export type PiiKind = 'PHONE' | 'EMAIL' | 'NIK' | 'BANK_ACCOUNT';

export interface PiiMatch {
  kind: PiiKind;
  /** Nilai yang cocok (dipotong untuk log; jangan disimpan utuh di audit). */
  redactedPreview: string;
  index: number;
}

const PII_PATTERNS: ReadonlyArray<{ kind: PiiKind; regex: RegExp; label: string }> = [
  // Nomor HP Indonesia: 08xxxxxxxxxx, +628xxxxxxxxxx, 628xxxxxxxxxx (9–14 digit).
  { kind: 'PHONE', regex: /(?:\+?62|0)8\d{7,12}\b/g, label: '[NOMOR-HP-DISENSOR]' },
  // Email.
  { kind: 'EMAIL', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label: '[EMAIL-DISENSOR]' },
  // NIK: tepat 16 digit (batas kata di kedua sisi).
  { kind: 'NIK', regex: /\b\d{16}\b/g, label: '[NIK-DISENSOR]' },
  // Nomor rekening: 10–16 digit yang bukan NIK dan bukan nomor HP.
  // Dijalankan SETELAH pola di atas supaya tidak menimpa placeholder.
  { kind: 'BANK_ACCOUNT', regex: /\b\d{10,16}\b/g, label: '[REKENING-DISENSOR]' },
];

export interface RedactResult {
  redactedText: string;
  matches: PiiMatch[];
  /** true bila tidak ada PII yang terdeteksi. */
  clean: boolean;
}

/**
 * Pindai `text`, kembalikan versi teredaksi + daftar temuan.
 * Urutan pola penting: PHONE → EMAIL → NIK → BANK_ACCOUNT (paling umum terakhir).
 */
export function redactPii(text: string): RedactResult {
  const matches: PiiMatch[] = [];
  let redacted = text;

  for (const { kind, regex, label } of PII_PATTERNS) {
    // Regex global dipakai ulang — reset lastIndex tiap pola.
    regex.lastIndex = 0;
    redacted = redacted.replace(regex, (m, offset: number) => {
      matches.push({
        kind,
        redactedPreview: `${m.slice(0, 3)}•••${m.slice(-2)}`,
        index: offset,
      });
      return label;
    });
  }

  return { redactedText: redacted, matches, clean: matches.length === 0 };
}

/** Ringkasan temuan untuk event audit — tanpa nilai PII mentah. */
export function summarizePiiMatches(matches: PiiMatch[]): string {
  const counts = new Map<PiiKind, number>();
  for (const m of matches) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, n]) => `${kind}×${n}`).join(', ');
}
