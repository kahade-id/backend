import { Prisma } from '@prisma/client';

/**
 * GAP-E (G301–G325) — utilitas turunan untuk antrean verifikasi badan usaha.
 *
 * Skema tidak menyimpan "jenis badan hukum" sebagai kolom tersendiri (dan
 * worker ini dilarang membuat migrasi baru), jadi jenis badan hukum
 * diturunkan dari awalan nama badan usaha mengikuti konvensi penamaan
 * Indonesia (PT/CV/UD/Firma/Koperasi/Yayasan/PD/BUMN/BUMD/Perum).
 *
 * Aturan derivasi dipakai di SATU tempat ini — service memakainya untuk
 * kolom `legalEntityType` di respons antrean/detail dan untuk membangun
 * filter SQL. Jangan duplikasi logika ini di modul lain.
 */

export type LegalEntityType =
  | 'PT'
  | 'CV'
  | 'UD'
  | 'FIRMA'
  | 'KOPERASI'
  | 'YAYASAN'
  | 'PD'
  | 'BUMN'
  | 'BUMD'
  | 'PERUM'
  | 'LAINNYA';

export const LEGAL_ENTITY_TYPES: LegalEntityType[] = [
  'PT',
  'CV',
  'UD',
  'FIRMA',
  'KOPERASI',
  'YAYASAN',
  'PD',
  'BUMN',
  'BUMD',
  'PERUM',
  'LAINNYA',
];

/** Awalan nama (token pertama, dinormalisasi) → jenis badan hukum. */
const PREFIX_TO_TYPE: Record<string, LegalEntityType> = {
  PT: 'PT',
  PERSEROAN: 'PT', // "Perseroan Terbatas ..." tanpa singkatan
  CV: 'CV',
  UD: 'UD',
  FIRMA: 'FIRMA',
  FA: 'FIRMA',
  KOPERASI: 'KOPERASI',
  KOP: 'KOPERASI',
  YAYASAN: 'YAYASAN',
  PD: 'PD',
  BUMN: 'BUMN',
  BUMD: 'BUMD',
  PERUM: 'PERUM',
  PERUSAHAAN: 'PERUM', // "Perusahaan Umum ..." tanpa singkatan
};

function normalizeToken(token: string): string {
  return token.replace(/[.,]/g, '').trim().toUpperCase();
}

/**
 * Turunkan jenis badan hukum dari nama badan usaha.
 * Mengembalikan 'LAINNYA' bila awalan tidak dikenali (mis. nama perorangan).
 */
export function deriveLegalEntityType(businessName?: string | null): LegalEntityType {
  if (!businessName) return 'LAINNYA';
  const firstToken = normalizeToken(businessName.trim().split(/\s+/)[0] ?? '');
  return PREFIX_TO_TYPE[firstToken] ?? 'LAINNYA';
}

/**
 * Filter Prisma untuk `legalEntityType` — pola `startsWith` case-insensitive
 * pada `businessName`, selaras dengan `deriveLegalEntityType`.
 * 'LAINNYA' = tidak cocok dengan pola mana pun.
 */
export function legalEntityTypeWhere(type: LegalEntityType): Prisma.BusinessVerificationWhereInput {
  const patterns: Record<Exclude<LegalEntityType, 'LAINNYA'>, string[]> = {
    PT: ['PT ', 'PT.', 'Perseroan '],
    CV: ['CV ', 'CV.'],
    UD: ['UD ', 'UD.'],
    FIRMA: ['Firma ', 'FA ', 'FA.'],
    KOPERASI: ['Koperasi ', 'Kop '],
    YAYASAN: ['Yayasan '],
    PD: ['PD ', 'PD.'],
    BUMN: ['BUMN ', 'BUMN.'],
    BUMD: ['BUMD ', 'BUMD.'],
    PERUM: ['Perum ', 'Perusahaan Umum '],
  };
  if (type === 'LAINNYA') {
    const all = Object.values(patterns).flat();
    return {
      AND: all.map((p) => ({ businessName: { startsWith: p, mode: 'insensitive' as const } })).map(
        (cond) => ({ NOT: cond }),
      ),
    };
  }
  const prefixes = patterns[type];
  return {
    OR: prefixes.map((p) => ({ businessName: { startsWith: p, mode: 'insensitive' as const } })),
  };
}

/**
 * Kelengkapan dokumen: minimal 1 dokumen terunggah DAN (nomor akta ATAU
 * nomor SIUP/NIB) terisi. Dipakai untuk filter "kelengkapan dokumen" dan
 * "menunggu dokumen tambahan".
 */
export function documentsCompleteWhere(complete: boolean): Prisma.BusinessVerificationWhereInput {
  const hasDocs: Prisma.BusinessVerificationWhereInput = {
    documentFileKeys: { isEmpty: false },
  };
  // Nomor berupa string kosong dianggap tidak terisi.
  const completeWhere: Prisma.BusinessVerificationWhereInput = {
    AND: [
      hasDocs,
      {
        OR: [
          { AND: [{ deedNumber: { not: null } }, { deedNumber: { not: '' } }] },
          { AND: [{ siupNumber: { not: null } }, { siupNumber: { not: '' } }] },
        ],
      },
    ],
  };
  return complete ? completeWhere : { NOT: completeWhere };
}

/**
 * Kelengkapan dokumen versi baris-JS (untuk kolom turunan di respons):
 * minimal 1 dokumen terunggah DAN (nomor akta ATAU nomor SIUP/NIB) terisi.
 */
export function isDocumentsCompleteRow(
  deedNumber?: string | null,
  siupNumber?: string | null,
  docCount?: number | null,
): boolean {
  const hasLegalNumber = Boolean(deedNumber?.trim()) || Boolean(siupNumber?.trim());
  return (docCount ?? 0) > 0 && hasLegalNumber;
}

/**
 * Masking NPWP untuk preview minim-PII: semua digit kecuali 4 digit terakhir
 * diganti '•', format grup Indonesia dipertahankan.
 * Contoh: "01.234.567.8-901.000" → "••.•••.•••.•-••1.000".
 */
export function maskNpwp(npwp?: string | null): string | null {
  if (!npwp) return null;
  const digits = npwp.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  const masked = '•'.repeat(digits.length - 4) + digits.slice(-4);
  if (digits.length === 15) {
    // Format NPWP 15 digit: XX.XXX.XXX.X-XXX.XXX
    const g = [2, 3, 3, 1, 3, 3];
    const parts: string[] = [];
    let i = 0;
    for (const len of g) {
      parts.push(masked.slice(i, i + len));
      i += len;
    }
    return `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}-${parts[4]}.${parts[5]}`;
  }
  if (digits.length === 16) {
    // Format NIK 16 digit: grup per 4
    return [0, 4, 8, 12].map((s) => masked.slice(s, s + 4)).join(' ');
  }
  return masked;
}
