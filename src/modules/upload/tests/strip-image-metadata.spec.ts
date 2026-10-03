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

/** Bangun satu box ISOBMFF: [size u32][type][payload]. */
function heicBox(type: string, payload: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length + 8);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), payload]);
}

const XMP_UUID_BYTES = Buffer.from([
  0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8,
  0x9c, 0x71, 0x99, 0x94, 0x91, 0xea, 0xfa, 0xac,
]);

/** HEIC minimal: ftyp(heic) + meta[Exif(GPS palsu) + uuid(XMP palsu) + iinf] + mdat. */
function heicWithMetadata(): Buffer {
  const ftyp = heicBox(
    'ftyp',
    Buffer.concat([
      Buffer.from('heic', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('mif1', 'ascii'),
    ]),
  );
  // Exif adalah FullBox: 4 byte version/flags + payload TIFF (berisi GPS palsu).
  const exif = heicBox('Exif', Buffer.concat([Buffer.alloc(4), Buffer.from('II*\0GPS-DATA-PALSU-HEIC')]));
  const xmp = heicBox('uuid', Buffer.concat([XMP_UUID_BYTES, Buffer.from('<x:xmpmeta>XMP-PALSU-HEIC</x:xmpmeta>')]));
  const iinf = heicBox('iinf', Buffer.concat([Buffer.alloc(4), Buffer.from('keep-me')]));
  const meta = heicBox('meta', Buffer.concat([Buffer.alloc(4), exif, xmp, iinf]));
  const mdat = heicBox('mdat', Buffer.from([1, 2, 3, 4]));
  return Buffer.concat([ftyp, meta, mdat]);
}

describe('stripImageMetadata — HEIC/HEIF (UPF-02)', () => {
  it('HEIC: payload box Exif & XMP dinol-kan, struktur box tetap utuh', () => {
    const input = heicWithMetadata();
    expect(input.includes('GPS-DATA-PALSU-HEIC')).toBe(true);
    expect(input.includes('XMP-PALSU-HEIC')).toBe(true);
    const out = stripImageMetadata(input, 'image/heic');
    // GPS & XMP hilang…
    expect(out.includes('GPS-DATA-PALSU-HEIC')).toBe(false);
    expect(out.includes('XMP-PALSU-HEIC')).toBe(false);
    // …tetapi struktur box utuh (ukuran sama → offset iloc tetap valid).
    expect(out.length).toBe(input.length);
    expect(out.subarray(4, 8).toString('ascii')).toBe('ftyp');
    expect(out.subarray(8, 12).toString('ascii')).toBe('heic');
    expect(out.includes('Exif')).toBe(true); // tipe box dipertahankan
    expect(out.includes('keep-me')).toBe(true); // box lain tak tersentuh
    expect(out).not.toBe(input); // buffer baru, bukan referensi sama
  });

  it('HEIC dengan mime image/heif juga ditangani', () => {
    const input = heicWithMetadata();
    const out = stripImageMetadata(input, 'image/heif');
    expect(out.includes('GPS-DATA-PALSU-HEIC')).toBe(false);
  });

  it('HEIC tanpa metadata: kembalikan referensi asli (tidak ada yang diubah)', () => {
    const ftyp = heicBox('ftyp', Buffer.concat([Buffer.from('heic', 'ascii'), Buffer.alloc(8)]));
    const meta = heicBox('meta', Buffer.concat([Buffer.alloc(4), heicBox('iinf', Buffer.from('x'))]));
    const input = Buffer.concat([ftyp, meta]);
    expect(stripImageMetadata(input, 'image/heic')).toBe(input);
  });

  it('bukan HEIF (brand isom) / struktur rusak: kembalikan apa adanya (fail-safe)', () => {
    const ftyp = heicBox('ftyp', Buffer.concat([Buffer.from('isom', 'ascii'), Buffer.alloc(8)]));
    const input = Buffer.concat([ftyp, heicBox('mdat', Buffer.from([1]))]);
    expect(stripImageMetadata(input, 'image/heic')).toBe(input);
    const truncated = Buffer.from('ftypheic'); // terlalu pendek
    expect(stripImageMetadata(truncated, 'image/heic')).toBe(truncated);
    const notHeic = Buffer.from('bukan gambar sama sekali');
    expect(stripImageMetadata(notHeic, 'image/heif')).toBe(notHeic);
  });
});

/** APP1 Exif dengan Orientation + tag Make berisi string GPS palsu (little-endian). */
function jpegWithOrientation(orientation: number): Buffer {
  // TIFF: "II" + 42 + offset IFD0=8.
  const tiffHead = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  const entry = (tag: number, type: number, count: number, value: number): Buffer => {
    const b = Buffer.alloc(12);
    b.writeUInt16LE(tag, 0);
    b.writeUInt16LE(type, 2);
    b.writeUInt32LE(count, 4);
    b.writeUInt32LE(value, 8);
    return b;
  };
  const gpsString = Buffer.from('GPS-DATA-PALSU-ORIENT\0');
  // IFD0: count=2, entry Orientation (inline), entry Make (offset ke string).
  // Layout: count(2) + 2 entry(24) + next(4) = 30 byte; string di offset 8+30=38.
  const ifd = Buffer.concat([
    Buffer.from([0x02, 0x00]),
    entry(0x0112, 3, 1, orientation),
    entry(0x010f, 2, gpsString.length, 38),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    gpsString,
  ]);
  const app1Data = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiffHead, ifd]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    jpegSeg(0xe1, app1Data),
    Buffer.concat([
      jpegSeg(0xda, Buffer.from([1, 2, 3, 4, 5, 6])),
      Buffer.from([0xff, 0xd9]), // EOI
    ]),
  ]);
}

describe('stripImageMetadata — preservasi Orientation JPEG (UPF-05)', () => {
  it('Orientation=6: APP1 dipertahankan minimal (hanya tag Orientation), GPS hilang', () => {
    const input = jpegWithOrientation(6);
    expect(input.includes('GPS-DATA-PALSU-ORIENT')).toBe(true);
    const out = stripImageMetadata(input, 'image/jpeg');
    // GPS hilang…
    expect(out.includes('GPS-DATA-PALSU-ORIENT')).toBe(false);
    // …tetapi APP1 Exif minimal tetap ada dengan nilai Orientation=6.
    expect(out.includes('Exif')).toBe(true);
    expect(
      out.includes(
        Buffer.from([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00]),
      ),
    ).toBe(true);
    // Struktur JPEG tetap valid.
    expect(out.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(out.subarray(out.length - 2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(out.length).toBeLessThan(input.length);
  });

  it('Orientation=1: APP1 dibuang seluruhnya (perilaku lama)', () => {
    const input = jpegWithOrientation(1);
    const out = stripImageMetadata(input, 'image/jpeg');
    expect(out.includes('GPS-DATA-PALSU-ORIENT')).toBe(false);
    expect(out.includes('Exif')).toBe(false);
  });
});
