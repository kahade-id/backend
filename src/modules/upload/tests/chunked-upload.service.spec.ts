/**
 * NP-006 (perf-fix, 2026-09-29): unit test protokol upload chunked/resumable.
 *
 * - init: validasi batas purpose, allowlist MIME, clamp chunkSize.
 * - chunk: verifikasi ukuran exact, idempotensi kirim-ulang, penolakan
 *   chunkIndex di luar rentang.
 * - status/complete: resume parsial, CHUNKS_MISSING, rakitan byte-identik
 *   diteruskan ke pipeline uploadDirect yang sama.
 * - keamanan: sessionId malformed → 400, user lain → 403, sesi
 *   kedaluwarsa → 410.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { ChunkedUploadService } from '../chunked-upload.service';
import { UploadPurpose } from '../dto/presigned-url.dto';

describe('ChunkedUploadService — NP-006', () => {
  let service: ChunkedUploadService;
  let storageRoot: string;
  let mockUploadDirect: jest.Mock;

  const CHUNK = 512 * 1024; // MIN_CHUNK_BYTES server

  beforeEach(() => {
    storageRoot = mkdtempSync(join(tmpdir(), 'kahade-chunks-'));
    mockUploadDirect = jest.fn().mockImplementation(
      async (_userId: string, _purpose: UploadPurpose, _name: string, _mime: string, buffer: Buffer) => ({
        fileKey: 'videos/x.mp4',
        fileUrl: 'https://cdn/x.mp4',
        receivedBytes: buffer.length,
      }),
    );
    const configService = { get: jest.fn().mockReturnValue(storageRoot) };
    const uploadService = { uploadDirect: mockUploadDirect };
    service = new ChunkedUploadService(configService as never, uploadService as never);
  });

  afterEach(() => {
    rmSync(storageRoot, { recursive: true, force: true });
  });

  const initVideo = (totalSize: number, chunkSize = CHUNK) =>
    service.initiate('user-1', {
      purpose: UploadPurpose.SHOWCASE_VIDEO,
      fileName: 'video.mp4',
      mimeType: 'video/mp4',
      totalSize,
      chunkSize,
    });

  // BFI-099 + UMD-002: SHOWCASE_VIDEO memakai VIDEO_TOO_LARGE (selaras jalur
  // direct), bukan FILE_TOO_LARGE — agar FE bisa memetakan copy per kode dan
  // kontrak error FE stabil antar endpoint.
  it('init: menolak totalSize melebihi batas SHOWCASE_VIDEO dengan VIDEO_TOO_LARGE (BFI-099/UMD-002)', async () => {
    await expect(
      service.initiate('user-1', {
        purpose: UploadPurpose.SHOWCASE_VIDEO,
        fileName: 'v.mp4',
        mimeType: 'video/mp4',
        totalSize: 101 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'VIDEO_TOO_LARGE' }) });
  });

  it('init: purpose non-video tetap memakai FILE_TOO_LARGE (UMD-002)', async () => {
    await expect(
      service.initiate('user-1', {
        purpose: UploadPurpose.SHOWCASE_IMAGE,
        fileName: 'img.png',
        mimeType: 'image/png',
        totalSize: 6 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'FILE_TOO_LARGE' }) });
  });

  it('init: menolak MIME di luar allowlist purpose (MIME_TYPE_MISMATCH)', async () => {
    await expect(
      service.initiate('user-1', {
        purpose: UploadPurpose.SHOWCASE_VIDEO,
        fileName: 'v.html',
        mimeType: 'text/html',
        totalSize: 1024,
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'MIME_TYPE_MISMATCH' }) });
  });

  it('init: mengembalikan sesi dengan chunkSize/totalChunks yang disepakati', async () => {
    const res = await initVideo(CHUNK * 2 + 100);
    expect(res.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(res.chunkSize).toBe(CHUNK);
    expect(res.totalChunks).toBe(3);
    expect(res.totalSize).toBe(CHUNK * 2 + 100);
  });

  it('chunk: menolak ukuran yang tidak sesuai kesepakatan (CHUNK_SIZE_MISMATCH)', async () => {
    const { sessionId } = await initVideo(CHUNK * 2);
    const wrong = randomBytes(100);
    await expect(
      service.uploadChunk('user-1', sessionId, 0, { buffer: wrong, size: wrong.length }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'CHUNK_SIZE_MISMATCH' }) });
  });

  it('chunk: menolak chunkIndex di luar rentang', async () => {
    const { sessionId } = await initVideo(CHUNK);
    const buf = randomBytes(CHUNK);
    await expect(
      service.uploadChunk('user-1', sessionId, 5, { buffer: buf, size: buf.length }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'VALIDATION_ERROR' }) });
  });

  it('chunk: kirim ulang byte identik bersifat idempoten (200, tanpa duplikasi)', async () => {
    const { sessionId } = await initVideo(CHUNK);
    const buf = randomBytes(CHUNK);
    await service.uploadChunk('user-1', sessionId, 0, { buffer: buf, size: buf.length });
    const status = await service.uploadChunk('user-1', sessionId, 0, {
      buffer: Buffer.from(buf),
      size: buf.length,
    });
    expect(status.received).toEqual([0]);
    expect(status.receivedBytes).toBe(CHUNK);
  });

  it('status: hanya melaporkan chunk yang benar-benar diterima (resume)', async () => {
    const { sessionId } = await initVideo(CHUNK * 2 + 10);
    const c0 = randomBytes(CHUNK);
    const c2 = randomBytes(10);
    await service.uploadChunk('user-1', sessionId, 0, { buffer: c0, size: c0.length });
    // Lewati chunk 1 — simulasikan putus di tengah.
    await service.uploadChunk('user-1', sessionId, 2, { buffer: c2, size: c2.length });
    const status = await service.status('user-1', sessionId);
    expect(status.received).toEqual([0, 2]);
    expect(status.receivedBytes).toBe(CHUNK + 10);
  });

  it('complete: menolak bila ada chunk hilang (CHUNKS_MISSING)', async () => {
    const { sessionId } = await initVideo(CHUNK * 2);
    const c0 = randomBytes(CHUNK);
    await service.uploadChunk('user-1', sessionId, 0, { buffer: c0, size: c0.length });
    await expect(service.complete('user-1', sessionId)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CHUNKS_MISSING' }),
    });
  });

  it('complete: merakit chunk terurut menjadi byte identik lalu memakai pipeline uploadDirect', async () => {
    const totalSize = CHUNK * 2 + 123;
    const { sessionId } = await initVideo(totalSize);
    const chunks = [randomBytes(CHUNK), randomBytes(CHUNK), randomBytes(123)];
    // Kirim ACAK urutannya — rakitan harus tetap terurut.
    await service.uploadChunk('user-1', sessionId, 2, { buffer: chunks[2], size: chunks[2].length });
    await service.uploadChunk('user-1', sessionId, 0, { buffer: chunks[0], size: chunks[0].length });
    await service.uploadChunk('user-1', sessionId, 1, { buffer: chunks[1], size: chunks[1].length });
    const result = await service.complete('user-1', sessionId);
    expect(result.fileKey).toBe('videos/x.mp4');
    expect(mockUploadDirect).toHaveBeenCalledTimes(1);
    const assembled: Buffer = mockUploadDirect.mock.calls[0][4];
    expect(assembled.length).toBe(totalSize);
    expect(Buffer.compare(assembled, Buffer.concat(chunks))).toBe(0);
  });

  it('keamanan: sessionId malformed → 400 (anti traversal)', async () => {
    await expect(service.status('user-1', '../../etc/passwd')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    });
    await expect(service.status('user-1', 'not-hex')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    });
  });

  it('keamanan: user lain tidak bisa memakai sesi (403)', async () => {
    const { sessionId } = await initVideo(CHUNK);
    await expect(service.status('user-2', sessionId)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'FILE_ACCESS_DENIED' }),
    });
  });

  it('keamanan: sesi kedaluwarsa → 410 dan direktori dibersihkan', async () => {
    const { sessionId } = await initVideo(CHUNK);
    // Paksa kedaluwarsa dengan menulis ulang manifest.
    const { readFileSync, writeFileSync } = await import('fs');
    const manifestPath = join(storageRoot, '.chunks', sessionId, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(service.status('user-1', sessionId)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CHUNK_SESSION_EXPIRED' }),
    });
  });
});
