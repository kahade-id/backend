/**
 * Test kontrak magic-byte audio (UPFV-01) + anchor box-size ftyp (UPFV-04).
 *
 * UPFV-01: voice note & lampiran audio mati total karena MAGIC_BYTES tidak
 * punya satu pun signature audio. Test ini mengunci bahwa setiap MIME audio
 * di whitelist CHAT_ATTACHMENT terdeteksi dari kontennya:
 *   audio/mpeg (ID3 / frame sync), audio/wav (RIFF+WAVE), audio/ogg (OggS),
 *   audio/mp4 (ftypM4A — konvensi server `.m4a ↔ audio/mp4`).
 *
 * UPFV-04: entri ftyp memvalidasi 4 byte pertama sebagai box-size yang waras
 * (defense-in-depth, konsisten dengan threat model anchoring B-38).
 */
import { detectMimeFromBytes } from '../upload.service';

const box = (size: number, brand: string): Buffer => {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(size, 0);
  buf.write('ftyp', 4, 'ascii');
  buf.write(brand, 8, 'ascii');
  return buf;
};

describe('detectMimeFromBytes — audio (UPFV-01)', () => {
  it('mp3 dengan tag ID3 → audio/mpeg', () => {
    const header = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
    expect(detectMimeFromBytes(header)).toBe('audio/mpeg');
  });

  it('mp3 frame sync (FF FB) → audio/mpeg', () => {
    const header = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detectMimeFromBytes(header)).toBe('audio/mpeg');
  });

  it('wav RIFF....WAVE → audio/wav', () => {
    const header = Buffer.alloc(16);
    header.write('RIFF', 0, 'ascii');
    header.write('WAVE', 8, 'ascii');
    expect(detectMimeFromBytes(header)).toBe('audio/wav');
  });

  it('RIFF tanpa WAVE (mis. WebP) bukan audio/wav', () => {
    const header = Buffer.alloc(16);
    header.write('RIFF', 0, 'ascii');
    header.write('WEBP', 8, 'ascii');
    expect(detectMimeFromBytes(header)).not.toBe('audio/wav');
  });

  it('ogg OggS → audio/ogg', () => {
    const header = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);
    expect(detectMimeFromBytes(header)).toBe('audio/ogg');
  });

  it('m4a ftypM4A (box-size waras) → audio/mp4', () => {
    expect(detectMimeFromBytes(box(32, 'M4A '))).toBe('audio/mp4');
  });
});

describe('detectMimeFromBytes — anchor box-size ftyp (UPFV-04)', () => {
  it('ftypisom dengan box-size waras → video/mp4', () => {
    expect(detectMimeFromBytes(box(24, 'isom'))).toBe('video/mp4');
  });

  it('ftyp dengan box-size 0 (extends) → ditolak', () => {
    expect(detectMimeFromBytes(box(0, 'isom'))).toBeNull();
  });

  it('ftyp dengan box-size 1 (largesize) → ditolak', () => {
    expect(detectMimeFromBytes(box(1, 'M4A '))).toBeNull();
  });

  it('ftyp dengan box-size raksasa (0xFFFFFFFF) → ditolak', () => {
    expect(detectMimeFromBytes(box(0xffffffff, 'isom'))).toBeNull();
  });

  it('polyglot "<htm" + ftyp (0x3C68746D > 4096) → ditolak', () => {
    const buf = Buffer.alloc(32);
    buf.write('<htm', 0, 'ascii'); // 0x3C68746D = 1014565741
    buf.write('ftyp', 4, 'ascii');
    buf.write('isom', 8, 'ascii');
    expect(detectMimeFromBytes(buf)).toBeNull();
  });

  it('header < 4 byte → ditolak (tidak throw)', () => {
    expect(detectMimeFromBytes(Buffer.from([0x66, 0x74]))).toBeNull();
  });

  it('ftypheic dengan box-size waras tetap → image/heic (tidak regresi)', () => {
    expect(detectMimeFromBytes(box(28, 'heic'))).toBe('image/heic');
  });
});
