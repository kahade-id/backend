/**
 * LOW (SEC-D): strip metadata privasi (EXIF/XMP/IPTC — termasuk koordinat GPS)
 * dari buffer gambar TANPA re-encode (lossless, tanpa penurunan kualitas).
 *
 * - JPEG: buang segmen APP1 (Exif/XMP) dan APP13 (Photoshop/IPTC). Segmen
 *   APP2 (profil warna ICC) DIPERTAHANKAN agar reproduksi warna tidak berubah.
 *   UPF-05: tag EXIF Orientation DIPERTAHANKAN dalam APP1 minimal — tanpa ini
 *   foto yang mengandalkan EXIF orientation tampil terputar setelah strip.
 * - PNG: buang chunk eXIf + chunk teks (tEXt/zTXt/iTXt).
 * - HEIC/HEIF (UPF-02): NOL-kan payload box `Exif` dan box XMP (`uuid`
 *   ber-UUID XMP) di dalam `meta`. Ukuran box TIDAK diubah sehingga offset
 *   `iloc` tetap valid; parser yang membaca EXIF yang sudah dinol-kan akan
 *   mengabaikannya (fail closed untuk GPS, fail open untuk struktur file).
 *
 * Cakupan: image/jpeg + image/png + image/heic + image/heif.
 * WebP/AVIF tidak ditangani di sini (butuh parser RIFF terpisah).
 *
 * Fail-safe: bila struktur file tidak seperti yang diharapkan, kembalikan
 * buffer ASLI (lebih baik metadata lolos daripada gambar korup).
 */

const JPEG_SOI_0 = 0xff;
const JPEG_SOI_1 = 0xd8;

const EXIF_ORIENTATION_TAG = 0x0112;
const EXIF_TYPE_SHORT = 3;

/**
 * UPF-05: baca tag EXIF Orientation dari data segmen APP1 (payload segmen,
 * sudah termasuk "Exif\0\0"). Kembalikan 1–8 bila valid, atau null bila
 * tidak ada / tak valid / bukan Exif.
 */
function readJpegOrientation(app1Data: Buffer): number | null {
  try {
    if (app1Data.length < 14) return null;
    if (
      app1Data[0] !== 0x45 || app1Data[1] !== 0x78 || app1Data[2] !== 0x69 || // "Exi"
      app1Data[3] !== 0x66 || app1Data[4] !== 0x00 || app1Data[5] !== 0x00 // "f\0\0"
    ) {
      return null;
    }
    const tiff = app1Data.subarray(6);
    if (tiff.length < 8) return null;
    const little = tiff[0] === 0x49 && tiff[1] === 0x49; // "II"
    const big = tiff[0] === 0x4d && tiff[1] === 0x4d; // "MM"
    if (!little && !big) return null;
    const u16 = (off: number): number =>
      little ? tiff.readUInt16LE(off) : tiff.readUInt16BE(off);
    const u32 = (off: number): number =>
      little ? tiff.readUInt32LE(off) : tiff.readUInt32BE(off);
    if (u16(2) !== 42) return null;
    const ifd0 = u32(4);
    if (ifd0 < 8 || ifd0 + 2 > tiff.length) return null;
    const count = u16(ifd0);
    if (count <= 0 || count > 256) return null;
    for (let i = 0; i < count; i++) {
      const e = ifd0 + 2 + i * 12;
      if (e + 12 > tiff.length) return null;
      if (u16(e) !== EXIF_ORIENTATION_TAG) continue;
      if (u16(e + 2) !== EXIF_TYPE_SHORT || u32(e + 4) !== 1) return null;
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * UPF-05: bangun payload APP1 minimal yang HANYA berisi tag Orientation
 * (tanpa GPS/XMP/IPTC/lainnya). Byte order dipertahankan dari EXIF asli
 * agar parser tidak bingung.
 */
function minimalExifWithOrientation(orientation: number, littleEndian: boolean): Buffer {
  // TIFF header (8) + jumlah entry (2) + 1 entry (12) + next-IFD (4).
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff[0] = littleEndian ? 0x49 : 0x4d;
  tiff[1] = littleEndian ? 0x49 : 0x4d;
  const w16 = (v: number, off: number): void => {
    if (littleEndian) tiff.writeUInt16LE(v, off);
    else tiff.writeUInt16BE(v, off);
  };
  const w32 = (v: number, off: number): void => {
    if (littleEndian) tiff.writeUInt32LE(v, off);
    else tiff.writeUInt32BE(v, off);
  };
  w16(42, 2);
  w32(8, 4); // offset IFD0
  w16(1, 8); // 1 entry
  w16(EXIF_ORIENTATION_TAG, 10);
  w16(EXIF_TYPE_SHORT, 12);
  w32(1, 14); // count = 1
  w16(orientation, 18); // nilai inline (2 byte <= 4 byte value field)
  w32(0, 22); // next IFD = 0
  return Buffer.concat([Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]), tiff]); // "Exif\0\0"
}

/**
 * UPF-05: bila APP1 adalah Exif dengan Orientation ≠ 1, kembalikan payload
 * APP1 minimal berisi HANYA tag Orientation; bila tidak, kembalikan null
 * (segmen dibuang seluruhnya seperti perilaku lama).
 */
function keepOrientationOnly(app1Data: Buffer): Buffer | null {
  const orientation = readJpegOrientation(app1Data);
  if (orientation === null || orientation === 1) return null;
  const littleEndian = app1Data[6] === 0x49; // byte order TIFF ("II" vs "MM")
  return minimalExifWithOrientation(orientation, littleEndian);
}

function stripJpegMetadata(buf: Buffer): Buffer {
  if (buf.length < 4 || buf[0] !== JPEG_SOI_0 || buf[1] !== JPEG_SOI_1) return buf;
  const out: Buffer[] = [buf.subarray(0, 2)]; // SOI
  let pos = 2;
  try {
    for (;;) {
      if (pos + 1 >= buf.length) return buf; // truncated — kembalikan asli
      if (buf[pos] !== 0xff) return buf; // bukan marker — struktur aneh
      let marker = buf[pos + 1];
      pos += 2;
      // Padding FF berlebih (legal di JPEG).
      while (marker === 0xff && pos < buf.length) {
        marker = buf[pos];
        pos += 1;
      }
      // Marker tanpa payload panjang.
      if (marker === 0xd9) {
        out.push(Buffer.from([0xff, 0xd9])); // EOI
        break;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        out.push(Buffer.from([0xff, marker]));
        continue;
      }
      if (pos + 1 >= buf.length) return buf;
      const segLen = buf.readUInt16BE(pos);
      if (segLen < 2 || pos + segLen > buf.length) return buf;
      const isApp1 = marker === 0xe1;
      const isApp13 = marker === 0xed;
      if (isApp1) {
        // UPF-05: APP1 Exif mungkin membawa tag Orientation — pertahankan
        // HANYA tag itu dalam APP1 minimal agar foto tidak tampil terputar;
        // GPS/XMP/IPTC ikut terbuang. APP1 non-Exif (XMP) dibuang seluruhnya.
        const kept = keepOrientationOnly(buf.subarray(pos + 2, pos + segLen));
        if (kept) {
          const lenBuf = Buffer.alloc(2);
          lenBuf.writeUInt16BE(kept.length + 2);
          out.push(Buffer.from([0xff, marker]), lenBuf, kept);
        }
        // else: buang segmen — JANGAN salin ke output.
      } else if (isApp13) {
        // Buang segmen (Photoshop/IPTC) — JANGAN salin ke output.
      } else {
        out.push(buf.subarray(pos - 2, pos + segLen));
      }
      pos += segLen;
      if (marker === 0xda) {
        // SOS: sisa file adalah data scan terkompresi — salin verbatim.
        out.push(buf.subarray(pos));
        break;
      }
    }
  } catch {
    return buf;
  }
  return Buffer.concat(out);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt']);

function stripPngMetadata(buf: Buffer): Buffer {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return buf;
  const out: Buffer[] = [buf.subarray(0, 8)];
  let pos = 8;
  try {
    for (;;) {
      if (pos + 8 > buf.length) return buf;
      const dataLen = buf.readUInt32BE(pos);
      const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
      const chunkEnd = pos + 8 + dataLen + 4; // len+type+data+crc
      if (dataLen > buf.length || chunkEnd > buf.length) return buf;
      if (!PNG_DROP_CHUNKS.has(type)) {
        out.push(buf.subarray(pos, chunkEnd));
      }
      pos = chunkEnd;
      if (type === 'IEND') break;
    }
  } catch {
    return buf;
  }
  return Buffer.concat(out);
}

/** Brand HEIF yang dikenal (ftyp major brand). */
const HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1',
]);

/** UUID box XMP dalam HEIF: 0xBE7ACFCB97A942E89C71999491EAFAC. */
const XMP_UUID = Buffer.from([
  0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8,
  0x9c, 0x71, 0x99, 0x94, 0x91, 0xea, 0xfa, 0xac,
]);

/**
 * Baca header satu box ISOBMFF di `pos`. Kembalikan { size, type, headerLen }
 * atau null bila struktur tak valid. size sudah mencakup header.
 */
function readBoxHeader(
  buf: Buffer,
  pos: number,
  limit: number,
): { size: number; type: string; headerLen: number } | null {
  if (pos + 8 > limit) return null;
  let size = buf.readUInt32BE(pos);
  const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
  let headerLen = 8;
  if (size === 1) {
    // largesize 64-bit.
    if (pos + 16 > limit) return null;
    const hi = buf.readUInt32BE(pos + 8);
    const lo = buf.readUInt32BE(pos + 12);
    if (hi !== 0 || lo < 16 || lo > limit - pos) return null;
    size = lo;
    headerLen = 16;
  } else if (size === 0) {
    size = limit - pos; // sampai akhir rentang
  }
  if (size < headerLen || pos + size > limit) return null;
  return { size, type, headerLen };
}

/**
 * Telusuri anak-anak box `meta` dalam [start, end); NOL-kan payload box
 * `Exif` dan box XMP (`uuid` ber-UUID XMP). `src` untuk baca, `dst` untuk
 * tulis (layout identik — offset sama). Kembalikan true bila ada yang diubah.
 */
function zeroHeicMetaChildren(src: Buffer, dst: Buffer, start: number, end: number): boolean {
  let changed = false;
  let pos = start;
  for (;;) {
    const h = readBoxHeader(src, pos, end);
    if (!h) return changed;
    if (h.type === 'Exif') {
      // FullBox: 4 byte version/flags setelah header — nol-kan sisanya.
      // Ukuran box TIDAK diubah: offset iloc tetap valid.
      const payloadStart = pos + h.headerLen + 4;
      if (payloadStart < pos + h.size) {
        dst.fill(0, payloadStart, pos + h.size);
        changed = true;
      }
    } else if (h.type === 'uuid') {
      // 16 byte UUID setelah header — nol-kan hanya bila UUID-nya XMP.
      const uuidStart = pos + h.headerLen;
      if (
        uuidStart + 16 <= pos + h.size &&
        src.subarray(uuidStart, uuidStart + 16).equals(XMP_UUID)
      ) {
        dst.fill(0, uuidStart + 16, pos + h.size);
        changed = true;
      }
    }
    pos += h.size;
    if (pos >= end) break;
  }
  return changed;
}

/**
 * UPF-02: strip metadata HEIC/HEIF. Kembalikan buffer baru bila ada metadata
 * yang dinol-kan; buffer ASLI bila tidak ada / format tak dikenal / struktur
 * tak valid (fail-safe).
 */
function stripHeicMetadata(buf: Buffer): Buffer {
  try {
    if (buf.length < 12) return buf;
    // Box pertama harus ftyp dengan major brand HEIF.
    const ftyp = readBoxHeader(buf, 0, buf.length);
    if (!ftyp || ftyp.type !== 'ftyp' || ftyp.size < 12) return buf;
    if (!HEIF_BRANDS.has(buf.subarray(8, 12).toString('ascii'))) return buf;

    const dst = Buffer.from(buf);
    let changed = false;
    let pos = 0;
    for (;;) {
      const h = readBoxHeader(buf, pos, buf.length);
      if (!h) return buf; // struktur aneh — kembalikan asli
      if (h.type === 'meta') {
        // Anak-anak meta mulai setelah 4 byte version/flags.
        if (zeroHeicMetaChildren(buf, dst, pos + h.headerLen + 4, pos + h.size)) {
          changed = true;
        }
      }
      pos += h.size;
      if (pos >= buf.length) break;
    }
    return changed ? dst : buf;
  } catch {
    return buf;
  }
}

/**
 * Strip metadata dari buffer gambar. Kembalikan buffer baru (mungkin sama
 * dengan input bila tidak ada metadata / format tak didukung / struktur
 * tak valid).
 */
export function stripImageMetadata(buffer: Buffer, mime: string): Buffer {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return buffer;
  if (mime === 'image/jpeg') return stripJpegMetadata(buffer);
  if (mime === 'image/png') return stripPngMetadata(buffer);
  if (mime === 'image/heic' || mime === 'image/heif') return stripHeicMetadata(buffer);
  return buffer;
}
