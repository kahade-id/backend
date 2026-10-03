import * as bcrypt from 'bcrypt';
import { JobApplicationStatus } from '@prisma/client';
import { CareersService, CV_PENDING_TTL_MS } from '../careers.service';
import { CareerCaptchaService } from '../captcha.service';
import { SubmitApplicationDto } from '../dto/submit-application.dto';

function makePrismaMock() {
  return {
    jobPosting: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn(), findMany: jest.fn() },
    jobApplication: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn(), findMany: jest.fn() },
    jobApplicationStatusHistory: { create: jest.fn() },
    $transaction: jest.fn(),
  };
}

const uploadServiceMock = {
  uploadDirect: jest.fn(),
  deleteStoredFile: jest.fn().mockResolvedValue(true),
  createSignedDownloadUrl: jest.fn().mockReturnValue({ downloadUrl: 'https://signed/x', expiresAt: new Date() }),
};

const configServiceMock = {
  // SMTP tidak terkonfigurasi di test → email fail-closed (skip + warn).
  get: jest.fn().mockReturnValue(''),
};

const captchaMock = {
  verifyChallenge: jest.fn().mockReturnValue(true),
};

function makeService(prisma: ReturnType<typeof makePrismaMock>) {
  return new CareersService(
    prisma as never,
    uploadServiceMock as never,
    captchaMock as unknown as CareerCaptchaService,
    configServiceMock as never,
    undefined,
  );
}

const activePosting = {
  id: 'posting-1',
  title: 'Co-Founder / COO',
  isActive: true,
  publishedAt: new Date(),
  closedAt: null,
};

function submitDto(overrides: Partial<SubmitApplicationDto> = {}): SubmitApplicationDto {
  return {
    postingId: 'posting-1',
    fullName: 'Budi Santoso',
    email: 'budi@example.com',
    phone: '081234567890',
    cvFileKey: 'uploads/career-cvs/uuid-1/f.pdf',
    captchaId: 'cid',
    captchaAnswer: 42,
    ...overrides,
  };
}

describe('CareersService.submitApplication', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: CareersService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrismaMock();
    service = makeService(prisma);
    prisma.jobPosting.findUnique.mockResolvedValue(activePosting);
    prisma.jobApplication.findFirst.mockResolvedValue(null);
    // Daftarkan cvFileKey sebagai "diterbitkan endpoint upload-cv".
    (service as unknown as { pendingCvKeys: Map<string, number> }).pendingCvKeys.set(
      'uploads/career-cvs/uuid-1/f.pdf',
      Date.now(),
    );
    const txApp = { id: 'app-1' };
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        jobApplication: { create: jest.fn().mockResolvedValue(txApp) },
        jobApplicationStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      }),
    );
  });

  it('sukses → { id, deletionToken } + history BARU, token mentah 64 hex', async () => {
    const res = await service.submitApplication(submitDto());
    expect(res.id).toBe('app-1');
    expect(res.deletionToken).toMatch(/^[0-9a-f]{64}$/);
    // cvFileKey ter-konsumsi (single-use): submit kedua dengan key sama → 410.
    await expect(service.submitApplication(submitDto())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CV_EXPIRED' }),
    });
  });

  it('duplikat aktif (BARU) → 409 ALREADY_APPLIED', async () => {
    prisma.jobApplication.findFirst.mockResolvedValue({ id: 'old', status: JobApplicationStatus.BARU });
    await expect(service.submitApplication(submitDto())).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'ALREADY_APPLIED' }),
    });
  });

  it('duplikat DITERIMA → 409 ALREADY_APPLIED (tetap diblokir)', async () => {
    prisma.jobApplication.findFirst.mockResolvedValue({ id: 'old', status: JobApplicationStatus.DITERIMA });
    await expect(service.submitApplication(submitDto())).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'ALREADY_APPLIED' }),
    });
  });

  it('duplikat DITOLAK → BOLEH lamar lagi (keputusan user)', async () => {
    prisma.jobApplication.findFirst.mockResolvedValue({ id: 'old', status: JobApplicationStatus.DITOLAK });
    const res = await service.submitApplication(submitDto());
    expect(res.id).toBe('app-1');
  });

  it('honeypot terisi → 400 BOT_DETECTED', async () => {
    await expect(service.submitApplication(submitDto({ website: 'http://spam.bot' }))).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'BOT_DETECTED' }),
    });
  });

  it('captcha salah → 400 CAPTCHA_INVALID', async () => {
    captchaMock.verifyChallenge.mockReturnValueOnce(false);
    await expect(service.submitApplication(submitDto())).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'CAPTCHA_INVALID' }),
    });
  });

  it('cvFileKey asing (tidak dari upload-cv) → 410 CV_EXPIRED', async () => {
    await expect(
      service.submitApplication(submitDto({ cvFileKey: 'uploads/kyc-ktp/victim/x.jpg' })),
    ).rejects.toMatchObject({
      status: 410,
      response: expect.objectContaining({ code: 'CV_EXPIRED' }),
    });
  });

  it('cvFileKey kedaluwarsa (>1 jam) → 410 CV_EXPIRED', async () => {
    (service as unknown as { pendingCvKeys: Map<string, number> }).pendingCvKeys.set(
      'uploads/career-cvs/uuid-1/f.pdf',
      Date.now() - CV_PENDING_TTL_MS - 1000,
    );
    await expect(service.submitApplication(submitDto())).rejects.toMatchObject({
      status: 410,
      response: expect.objectContaining({ code: 'CV_EXPIRED' }),
    });
  });

  it('lowongan tidak aktif → 404 POSTING_NOT_FOUND', async () => {
    prisma.jobPosting.findUnique.mockResolvedValue({ ...activePosting, isActive: false });
    await expect(service.submitApplication(submitDto())).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: 'POSTING_NOT_FOUND' }),
    });
  });
});

describe('CareersService.updateApplicationStatus', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: CareersService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrismaMock();
    service = makeService(prisma);
  });

  function mockApp(status: JobApplicationStatus) {
    const app = {
      id: 'app-1',
      status,
      fullName: 'Budi',
      email: 'budi@example.com',
      posting: { title: 'Co-Founder / COO' },
    };
    prisma.jobApplication.findUnique.mockResolvedValue(app);
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        jobApplication: { update: jest.fn().mockImplementation(async ({ data }: { data: unknown }) => ({ ...app, ...(data as object) })) },
        jobApplicationStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      }),
    );
    return app;
  }

  it('BARU → DIREVIEW valid + catat history', async () => {
    mockApp(JobApplicationStatus.BARU);
    const historyCreate = jest.fn().mockResolvedValue({});
    prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        jobApplication: { update: jest.fn().mockResolvedValue({}) },
        jobApplicationStatusHistory: { create: historyCreate },
      }),
    );
    const res = await service.updateApplicationStatus(
      'app-1',
      { status: JobApplicationStatus.DIREVIEW, note: 'CV bagus' },
      'admin-1',
    );
    expect(res).toBeDefined();
    expect(historyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: JobApplicationStatus.BARU,
        toStatus: JobApplicationStatus.DIREVIEW,
        changedBy: 'admin-1',
        note: 'CV bagus',
      }),
    });
  });

  it('BARU → DITERIMA langsung → 400 INVALID_STATUS_TRANSITION', async () => {
    mockApp(JobApplicationStatus.BARU);
    await expect(
      service.updateApplicationStatus('app-1', { status: JobApplicationStatus.DITERIMA }, 'admin-1'),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'INVALID_STATUS_TRANSITION' }),
    });
  });

  it('status sama → 400', async () => {
    mockApp(JobApplicationStatus.BARU);
    await expect(
      service.updateApplicationStatus('app-1', { status: JobApplicationStatus.BARU }, 'admin-1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INVALID_STATUS_TRANSITION' }),
    });
  });

  it('DITOLAK → DIREVIEW tanpa catatan → 400 (reopen terminal wajib catatan)', async () => {
    mockApp(JobApplicationStatus.DITOLAK);
    await expect(
      service.updateApplicationStatus('app-1', { status: JobApplicationStatus.DIREVIEW }, 'admin-1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INVALID_STATUS_TRANSITION' }),
    });
  });

  it('DITOLAK → DIREVIEW dengan catatan → boleh', async () => {
    mockApp(JobApplicationStatus.DITOLAK);
    const res = await service.updateApplicationStatus(
      'app-1',
      { status: JobApplicationStatus.DIREVIEW, note: 'Pelamar meminta review ulang' },
      'admin-1',
    );
    expect(res).toBeDefined();
  });

  it('DITERIMA → DITOLAK → 400 (terminal tidak bisa ke terminal lain)', async () => {
    mockApp(JobApplicationStatus.DITERIMA);
    await expect(
      service.updateApplicationStatus(
        'app-1',
        { status: JobApplicationStatus.DITOLAK, note: 'x' },
        'admin-1',
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INVALID_STATUS_TRANSITION' }),
    });
  });
});

describe('CareersService.uploadCv', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: CareersService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrismaMock();
    service = makeService(prisma);
    uploadServiceMock.uploadDirect.mockResolvedValue({
      fileKey: 'uploads/career-cvs/uuid-1/123-abc-cv.pdf',
      fileUrl: 'x',
    });
  });

  it('nama file user TIDAK dipakai — selalu "cv.pdf" generet server', async () => {
    const res = await service.uploadCv({
      originalname: '../../etc/passwd.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fake'),
    });
    expect(uploadServiceMock.uploadDirect).toHaveBeenCalledWith(
      expect.any(String),
      'CAREER_CV',
      'cv.pdf',
      'application/pdf',
      expect.any(Buffer),
    );
    expect(res.fileKey).toBe('uploads/career-cvs/uuid-1/123-abc-cv.pdf');
    expect(res.expiresIn).toBe(Math.floor(CV_PENDING_TTL_MS / 1000));
    // Key terdaftar sebagai pending → bisa dipakai submit.
    const pending = (service as unknown as { pendingCvKeys: Map<string, number> }).pendingCvKeys;
    expect(pending.has('uploads/career-cvs/uuid-1/123-abc-cv.pdf')).toBe(true);
  });
});

describe('CareersService.deleteApplicationByToken', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: CareersService;
  const rawToken = 'a'.repeat(64);

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = makePrismaMock();
    service = makeService(prisma);
    prisma.jobApplication.findUnique.mockResolvedValue({
      id: 'app-1',
      cvFileKey: 'uploads/career-cvs/u/f.pdf',
      deletionTokenHash: await bcrypt.hash(rawToken, 4),
    });
    prisma.jobApplication.delete.mockResolvedValue({});
  });

  it('token benar → file CV dihapus + hard delete, { deleted: true }', async () => {
    const res = await service.deleteApplicationByToken('app-1', rawToken);
    expect(res).toEqual({ deleted: true });
    expect(uploadServiceMock.deleteStoredFile).toHaveBeenCalledWith('uploads/career-cvs/u/f.pdf');
    expect(prisma.jobApplication.delete).toHaveBeenCalledWith({ where: { id: 'app-1' } });
  });

  it('token salah → 403 INVALID_DELETION_TOKEN, data TIDAK dihapus', async () => {
    await expect(service.deleteApplicationByToken('app-1', 'b'.repeat(64))).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: 'INVALID_DELETION_TOKEN' }),
    });
    expect(prisma.jobApplication.delete).not.toHaveBeenCalled();
  });

  it('lamaran tidak ada → 404', async () => {
    prisma.jobApplication.findUnique.mockResolvedValue(null);
    await expect(service.deleteApplicationByToken('x', rawToken)).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: 'APPLICATION_NOT_FOUND' }),
    });
  });
});

describe('CareersService admin posting guards', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: CareersService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrismaMock();
    service = makeService(prisma);
  });

  it('createPosting slug duplikat → 409 SLUG_ALREADY_USED', async () => {
    prisma.jobPosting.findUnique.mockResolvedValue({ id: 'p1' });
    await expect(
      service.createPosting(
        {
          slug: 'co-founder-coo',
          title: 'Co-Founder / COO',
          location: 'Remote',
          type: 'Penuh waktu',
          equity: '15% saham',
          summary: 'Ringkasan cukup panjang di sini',
          description: 'Deskripsi yang cukup panjang untuk validasi',
        },
        'admin-1',
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'SLUG_ALREADY_USED' }),
    });
  });

  it('deletePosting dengan lamaran → 409 DELETE_BLOCKED_HAS_APPLICATIONS', async () => {
    prisma.jobPosting.findUnique.mockResolvedValue({ id: 'p1', _count: { applications: 3 } });
    await expect(service.deletePosting('p1')).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'DELETE_BLOCKED_HAS_APPLICATIONS' }),
    });
    expect(prisma.jobPosting.delete).not.toHaveBeenCalled();
  });
});
