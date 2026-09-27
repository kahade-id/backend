/**
 * GAP-D stok — konstanta domain (G252/G253/G263–G265).
 *
 * Pesan user-facing Bahasa Indonesia.
 */

/** G252: format SKU — 3–48 karakter, huruf kapital/angka/titik/underscore/strip. */
export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{2,47}$/;
export const SKU_PATTERN_MESSAGE =
  'SKU harus 3–48 karakter: huruf kapital, angka, titik, underscore, atau strip (mis. KAHADE-SEPATU-001).';

/** G253: batas atribut varian. */
export const MAX_VARIANT_ATTRIBUTES = 5;
export const MAX_ATTRIBUTE_VALUES = 50;

/** G263: batas impor CSV. */
export const CSV_MAX_ROWS = 1000;
export const CSV_MAX_BYTES = 512 * 1024; // 512 KB

/** G265: batas bulk update. */
export const BULK_MAX_ROWS = 500;

/** Katalog: batas halaman. */
export const CATALOG_DEFAULT_LIMIT = 20;
export const CATALOG_MAX_LIMIT = 100;

/** Normalisasi SKU: trim + uppercase (G252). */
export function normalizeSku(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidSku(raw: string): boolean {
  return SKU_PATTERN.test(normalizeSku(raw));
}

/**
 * G253: canonical key kombinasi atribut — kunci diurutkan agar
 * {ukuran:M, warna:Merah} == {warna:Merah, ukuran:M} terdeteksi duplikat.
 */
export function canonicalAttributeKey(attributes: Record<string, string>): string {
  return Object.keys(attributes)
    .sort()
    .map(k => `${k.trim().toLowerCase()}=${String(attributes[k]).trim().toLowerCase()}`)
    .join('|');
}

/**
 * G253: validasi attributes varian terhadap attributesSchema produk.
 * Schema: { "ukuran": ["S","M","L"], "warna": ["Merah","Hitam"] }.
 * Mengembalikan pesan error Bahasa Indonesia, atau null bila valid.
 */
export function validateVariantAttributes(
  schema: unknown,
  attributes: unknown,
): string | null {
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return 'Atribut varian harus berupa objek (mis. {"ukuran":"M","warna":"Merah"}).';
  }
  const attrs = attributes as Record<string, unknown>;
  const keys = Object.keys(attrs);
  if (keys.length === 0) return 'Varian harus memiliki minimal satu atribut (mis. ukuran/warna).';
  if (keys.length > MAX_VARIANT_ATTRIBUTES) {
    return `Maksimal ${MAX_VARIANT_ATTRIBUTES} atribut per varian.`;
  }
  if (schema != null) {
    if (typeof schema !== 'object' || Array.isArray(schema)) {
      return 'Skema atribut produk tidak valid.';
    }
    const schemaObj = schema as Record<string, unknown>;
    for (const key of keys) {
      const allowed = schemaObj[key];
      if (!Array.isArray(allowed)) {
        return `Atribut "${key}" tidak terdaftar pada produk ini.`;
      }
      const value = String(attrs[key] ?? '').trim().toLowerCase();
      const allowedLower = allowed.map(v => String(v).trim().toLowerCase());
      if (!allowedLower.includes(value)) {
        return `Nilai "${attrs[key]}" tidak valid untuk atribut "${key}". Pilihan: ${allowed.join(', ')}.`;
      }
    }
  }
  for (const key of keys) {
    const v = attrs[key];
    if (typeof v !== 'string' || v.trim().length === 0) {
      return `Nilai atribut "${key}" tidak boleh kosong.`;
    }
  }
  return null;
}

/** Label varian untuk snapshot order line, mis. "Ukuran M, Warna Merah". */
export function variantLabelOf(attributes: Record<string, string>): string {
  return Object.keys(attributes)
    .sort()
    .map(k => `${capitalize(k)} ${attributes[k]}`)
    .join(', ');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Format rupiah dari sen (BigInt-safe, tanpa float math). */
export function formatRupiah(sen: bigint | number | string): string {
  const n = typeof sen === 'bigint' ? sen : BigInt(String(sen));
  const rupiah = n / 100n;
  return `Rp${rupiah.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}
