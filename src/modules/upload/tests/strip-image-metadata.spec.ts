import { stripImageMetadata } from '../utils/strip-image-metadata';

/** Bangun segmen JPEG dengan panjang otomatis (hindari salah hitung manual). */
function jpegSeg(marker: number, data: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(data.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, data]);
}

/** JPEG minimal: SOI + APP1(Exif) + APP0(JFIF) + APP13 + SOS + data + EOI. */
function jpegWithMetadata(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    jpegSeg(0xe1, Buffer.from('Exif\0\0GPS-DATA-PALSU-1234567890')),
    jpegSeg(0xe0, Buffer.from('JFIF\0AAAAAAAAA')),
    jpegSeg(0xed, Buffer.from('Photoshop/IPTC')),
    Buffer.concat([
      jpegSeg(0xda, Buffer.from([1, 2, 3, 4, 5, 6])),
      Buffer.from([0x11, 0x22, 0xff, 0x00, 0x33]), // data scan (ada FF 00)
      Buffer.from([0xff, 0xd9]), // EOI
    ]),
  ]);
}

function pngWithMetadata(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    sig,
    chunk('IHDR', Buffer.alloc(13)),
    chunk('eXIf', Buffer.from('EXIF-GPS-PALSU')),
    chunk('tEXt', Buffer.from('Comment\0halo')),
    chunk('IDAT', Buffer.from([1, 2, 3, 4])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('stripImageMetadata (SEC-D LOW: EXIF/GPS)', () => {
  it('JPEG: membuang APP1 (Exif) & APP13, mempertahankan APP0 + data gambar', () => {
    const input = jpegWithMetadata();
    expect(input.includes('GPS-DATA-PALSU')).toBe(true);
    const out = stripImageMetadata(input, 'image/jpeg');
    expect(out.includes('GPS-DATA-PALSU')).toBe(false);
    expect(out.includes('Photoshop/IPTC')).toBe(false);
    // JFIF + data scan tetap ada; struktur SOI..EOI valid.
    expect(out.includes('JFIF')).toBe(true);
    expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(out.subarray(out.length - 2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(out.includes(Buffer.from([0x11, 0x22, 0xff, 0x00, 0x33]))).toBe(true);
    expect(out.length).toBeLessThan(input.length);
  });

  it('JPEG tanpa metadata: output identik dengan input', () => {
    const input = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x10]),
      Buffer.from('JFIF\0AAAAAAAAA'),
      Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0x11, 0x22, 0xff, 0xd9]),
    ]);
    expect(stripImageMetadata(input, 'image/jpeg')).toEqual(input);
  });

  it('PNG: membuang eXIf + tEXt, mempertahankan IHDR/IDAT/IEND', () => {
    const input = pngWithMetadata();
    const out = stripImageMetadata(input, 'image/png');
    expect(out.includes('EXIF-GPS-PALSU')).toBe(false);
    expect(out.includes('halo')).toBe(false);
    expect(out.includes('IHDR')).toBe(true);
    expect(out.includes('IDAT')).toBe(true);
    expect(out.includes('IEND')).toBe(true);
    expect(out.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('format tak didukung / buffer rusak: kembalikan apa adanya (fail-safe)', () => {
    const webp = Buffer.from('RIFF....WEBP');
    expect(stripImageMetadata(webp, 'image/webp')).toBe(webp);
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00]); // terpotong
    expect(stripImageMetadata(truncated, 'image/jpeg')).toBe(truncated);
    const notJpeg = Buffer.from('bukan gambar sama sekali');
    expect(stripImageMetadata(notJpeg, 'image/jpeg')).toBe(notJpeg);
  });
});
