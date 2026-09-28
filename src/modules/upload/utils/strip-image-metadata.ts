/**
 * LOW (SEC-D): strip metadata privasi (EXIF/XMP/IPTC — termasuk koordinat GPS)
 * dari buffer gambar TANPA re-encode (lossless, tanpa penurunan kualitas).
 *
 * - JPEG: buang segmen APP1 (Exif/XMP) dan APP13 (Photoshop/IPTC). Segmen
 *   APP2 (profil warna ICC) DIPERTAHANKAN agar reproduksi warna tidak berubah.
 * - PNG: buang chunk eXIf + chunk teks (tEXt/zTXt/iTXt).
 *
 * Cakupan: image/jpeg + image/png (format foto kamera HP). HEIC/WebP/AVIF
 * tidak ditangani di sini — residual tercatat di laporan (butuh parser
 * ISOBMFF/RIFF terpisah).
 *
 * Fail-safe: bila struktur file tidak seperti yang diharapkan, kembalikan
 * buffer ASLI (lebih baik metadata lolos daripada gambar korup).
 */

const JPEG_SOI_0 = 0xff;
const JPEG_SOI_1 = 0xd8;

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
      if (isApp1 || isApp13) {
        // Buang segmen (Exif/XMP/IPTC) — JANGAN salin ke output.
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

/**
 * Strip metadata dari buffer gambar. Kembalikan buffer baru (mungkin sama
 * dengan input bila tidak ada metadata / format tak didukung / struktur
 * tak valid).
 */
export function stripImageMetadata(buffer: Buffer, mime: string): Buffer {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return buffer;
  if (mime === 'image/jpeg') return stripJpegMetadata(buffer);
  if (mime === 'image/png') return stripPngMetadata(buffer);
  return buffer;
}
