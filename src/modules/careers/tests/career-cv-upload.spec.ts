import { UploadService, MAX_FILE_SIZE, ALLOWED_CONTENT_TYPES, isSafeFileKey } from '../../upload/upload.service';
import { UploadPurpose } from '../../upload/dto/presigned-url.dto';

function makePdf(sizeBytes: number): Buffer {
  const header = Buffer.from('%PDF-1.4\n% fake cv\n');
  const filler = Buffer.alloc(Math.max(0, sizeBytes - header.length), 0x20);
  return Buffer.concat([header, filler]);
}

function makePng(sizeBytes = 2048): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, sizeBytes - header.length), 0)]);
}

function makeUploadService() {
  const localStorage = {
    saveFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(true),
  };
  const config = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'STORAGE_URL_SECRET' || key === 'JWT_SECRET') return 'test-secret-min-32-chars-xxxxxxxx';
      return undefined;
    }),
  };
  const redis = { setNx: jest.fn().mockResolvedValue(true) };
  const service = new UploadService(
    config as never,
    redis as never,
    localStorage as never,
    {} as never,
  );
  return { service, localStorage };
}

describe('CAREER_CV purpose config', () => {
  it('PDF-only allowlist', () => {
    expect(ALLOWED_CONTENT_TYPES[UploadPurpose.CAREER_CV]).toEqual(['application/pdf']);
  });

  it('batas 5 MB', () => {
    expect(MAX_FILE_SIZE[UploadPurpose.CAREER_CV]).toBe(5 * 1024 * 1024);
  });

  it('folder storage = career-cvs (terbukti dari key hasil uploadDirect)', async () => {
    // PURPOSE_FOLDER_MAP bersifat private; verifikasi lewat perilaku:
    // key hasil upload selalu berprefix uploads/career-cvs/ (lihat test
    // "PDF valid" di bawah). Folder career-cvs tidak ada di lokasi publik
    // nginx (deploy/nginx.conf: hanya avatars/headers/showcase-images).
    const { service } = makeUploadService();
    const res = await service.uploadDirect('u', UploadPurpose.CAREER_CV, 'cv.pdf', 'application/pdf', makePdf(2048));
    expect(res.fileKey.startsWith('uploads/career-cvs/')).toBe(true);
  });
});

describe('CareersService CV guards (via UploadService.uploadDirect CAREER_CV)', () => {
  it('PDF valid ≤5MB → diterima; key aman, ekstensi .pdf dari MIME terdeteksi', async () => {
    const { service } = makeUploadService();
    const res = await service.uploadDirect('owner-uuid-1', UploadPurpose.CAREER_CV, 'CV Budi.pdf', 'application/pdf', makePdf(4096));
    expect(res.fileKey).toMatch(/^uploads\/career-cvs\/owner-uuid-1\/[0-9]+-[A-Za-z0-9_-]+\.pdf$/);
    expect(isSafeFileKey(res.fileKey)).toBe(true);
  });

  it('konten PNG dideklarasikan application/pdf → 400 MIME_TYPE_MISMATCH', async () => {
    const { service } = makeUploadService();
    await expect(
      service.uploadDirect('u', UploadPurpose.CAREER_CV, 'cv.pdf', 'application/pdf', makePng()),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MIME_TYPE_MISMATCH' }),
    });
  });

  it('deklarasi image/png (konten PNG asli) → 400 MIME_TYPE_MISMATCH (allowlist PDF-only)', async () => {
    const { service } = makeUploadService();
    await expect(
      service.uploadDirect('u', UploadPurpose.CAREER_CV, 'cv.png', 'image/png', makePng()),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MIME_TYPE_MISMATCH' }),
    });
  });

  it('PDF >5MB → 413 FILE_TOO_LARGE', async () => {
    const { service } = makeUploadService();
    await expect(
      service.uploadDirect('u', UploadPurpose.CAREER_CV, 'besar.pdf', 'application/pdf', makePdf(6 * 1024 * 1024)),
    ).rejects.toMatchObject({
      status: 413,
      response: expect.objectContaining({ code: 'FILE_TOO_LARGE' }),
    });
  });

  it('filename traversal "../../etc/passwd.pdf" → tidak bisa keluar direktori (tepat 4 segmen)', async () => {
    const { service } = makeUploadService();
    const res = await service.uploadDirect('u', UploadPurpose.CAREER_CV, '../../etc/passwd.pdf', 'application/pdf', makePdf(2048));
    // Segmen filename tidak mengandung '/' → path tetap di dalam career-cvs/<owner>/.
    expect(res.fileKey.split('/').length).toBe(4);
    expect(res.fileKey.split('/')[3]).not.toContain('/');
    // CATATAN: CareersService.uploadCv bahkan tidak meneruskan nama file user
    // (selalu 'cv.pdf') — lihat careers.service.spec.ts.
  });

  it('filename "exploit.html" berisi PDF → tersimpan sebagai .pdf (bukan .html)', async () => {
    const { service } = makeUploadService();
    const res = await service.uploadDirect('u', UploadPurpose.CAREER_CV, 'exploit.html', 'application/pdf', makePdf(2048));
    expect(res.fileKey.endsWith('.pdf')).toBe(true);
    expect(res.fileKey).not.toContain('.html');
  });
});
