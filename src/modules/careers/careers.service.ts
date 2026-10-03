import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { JobApplicationStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { UploadPurpose } from '../upload/dto/presigned-url.dto';
import { EMAIL_QUEUE, EmailJobData } from '../queue/processors/email.processor';
import * as ErrorCodes from '../../common/constants/error-codes';
import { CareerCaptchaService } from './captcha.service';
import { CreateJobPostingDto } from './dto/create-job-posting.dto';
import { UpdateJobPostingDto } from './dto/update-job-posting.dto';
import { SubmitApplicationDto } from './dto/submit-application.dto';
import { UpdateApplicationStatusDto } from './dto/update-application-status.dto';
import {
  CAREER_EMAIL_TEMPLATES,
  CareerEmailContext,
  CareerEmailTemplate,
  enqueueCareerEmail,
} from './career-email';

/** CV yang diupload tapi belum dipakai submit kedaluwarsa 1 jam (one-time consume). */
export const CV_PENDING_TTL_MS = 60 * 60 * 1000;

/** Transisi status yang diizinkan. DITERIMA/DITOLAK terminal — dibuka ulang ke DIREVIEW hanya via admin + catatan. */
export const ALLOWED_STATUS_TRANSITIONS: Record<JobApplicationStatus, JobApplicationStatus[]> = {
  [JobApplicationStatus.BARU]: [JobApplicationStatus.DIREVIEW, JobApplicationStatus.DITOLAK],
  [JobApplicationStatus.DIREVIEW]: [JobApplicationStatus.WAWANCARA, JobApplicationStatus.DITOLAK],
  [JobApplicationStatus.WAWANCARA]: [JobApplicationStatus.DITERIMA, JobApplicationStatus.DITOLAK],
  [JobApplicationStatus.DITERIMA]: [JobApplicationStatus.DIREVIEW],
  [JobApplicationStatus.DITOLAK]: [JobApplicationStatus.DIREVIEW],
};

const STATUS_EMAIL_TEMPLATE: Partial<Record<JobApplicationStatus, CareerEmailTemplate>> = {
  [JobApplicationStatus.DIREVIEW]: CAREER_EMAIL_TEMPLATES.STATUS_REVIEW,
  [JobApplicationStatus.WAWANCARA]: CAREER_EMAIL_TEMPLATES.STATUS_INTERVIEW,
  [JobApplicationStatus.DITERIMA]: CAREER_EMAIL_TEMPLATES.STATUS_ACCEPTED,
  [JobApplicationStatus.DITOLAK]: CAREER_EMAIL_TEMPLATES.STATUS_REJECTED,
};

interface UploadedCvFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 128);
}

@Injectable()
export class CareersService {
  private readonly logger = new Logger(CareersService.name);
  /**
   * Registry fileKey CV yang diterbitkan endpoint upload-cv dan belum dipakai
   * submit: fileKey → timestamp upload. Single-use (dihapus saat submit) +
   * TTL 1 jam. Key yang tidak ada di sini DITOLAK saat submit (410 CV_EXPIRED)
   * — menjamin fileKey berasal dari endpoint ini, bukan key asing (mis. KYC).
   */
  private readonly pendingCvKeys = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly captchaService: CareerCaptchaService,
    private readonly configService: ConfigService,
    @Optional() @InjectQueue(EMAIL_QUEUE) private readonly emailQueue?: Queue<EmailJobData>,
  ) {}

  // ── Captcha ──────────────────────────────────────────────────────────────

  issueCaptcha() {
    return this.captchaService.issueChallenge();
  }

  // ── Lowongan publik ──────────────────────────────────────────────────────

  async listPublicPostings(activeOnly = true) {
    const postings = await this.prisma.jobPosting.findMany({
      where: activeOnly
        ? { isActive: true, publishedAt: { not: null }, closedAt: null }
        : undefined,
      orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }],
      select: {
        id: true,
        slug: true,
        title: true,
        location: true,
        type: true,
        equity: true,
        summary: true,
        publishedAt: true,
      },
    });
    // TANPA description penuh / requirements — hemat payload kartu.
    return { postings };
  }

  async getPublicPosting(slug: string) {
    const posting = await this.prisma.jobPosting.findUnique({ where: { slug } });
    if (!posting || !posting.isActive || !posting.publishedAt || posting.closedAt) {
      throw new NotFoundException({
        code: ErrorCodes.POSTING_NOT_FOUND,
        message: 'Lowongan tidak ditemukan atau sudah ditutup.',
      });
    }
    return posting;
  }

  // ── Upload CV (publik, tanpa akun) ───────────────────────────────────────

  /**
   * Terima file CV → UploadService.uploadDirect (purpose CAREER_CV):
   * - MIME allowlist ['application/pdf'] + magic-byte %PDF WAJIB cocok dengan
   *   deklarasi (tolak mismatch) — upload.service.ts:uploadDirectTx
   * - Batas 5 MB: multer interceptor endpoint (5 MiB) + MAX_FILE_SIZE server-side
   * - Nama file TIDAK diambil dari user (input tak tepercaya) — selalu
   *   `cv.pdf`; ekstensi dari MIME terdeteksi (SH-S-001)
   * - Key = uploads/career-cvs/<uuid>/… (uuid acak — tidak bisa ditebak,
   *   tidak sequential); selalu lolos isSafeFileKey (tanpa sisa "..")
   * - Folder `career-cvs` privat: nginx TIDAK serve prefix ini (deploy/nginx.conf)
   */
  async uploadCv(file: UploadedCvFile): Promise<{ fileKey: string; expiresIn: number }> {
    const ownerId = randomUUID();
    const result = await this.uploadService.uploadDirect(
      ownerId,
      UploadPurpose.CAREER_CV,
      'cv.pdf', // nama file generet server — originalname user diabaikan
      file.mimetype,
      file.buffer,
    );
    this.pendingCvKeys.set(result.fileKey, Date.now());
    return { fileKey: result.fileKey, expiresIn: Math.floor(CV_PENDING_TTL_MS / 1000) };
  }

  // ── Submit lamaran (publik) ─────────────────────────────────────────────

  async submitApplication(dto: SubmitApplicationDto): Promise<{ id: string; deletionToken: string }> {
    // 1. Honeypot anti-bot.
    if (dto.website && dto.website.trim() !== '') {
      throw new BadRequestException({
        code: ErrorCodes.BOT_DETECTED,
        message: 'Terdeteksi aktivitas otomatis. Silakan coba lagi.',
      });
    }

    // 2. Captcha wajib, verifikasi server-side (single-use, TTL 5 menit).
    if (!this.captchaService.verifyChallenge(dto.captchaId, dto.captchaAnswer)) {
      throw new BadRequestException({
        code: ErrorCodes.CAPTCHA_INVALID,
        message: 'Kode verifikasi salah atau sudah kedaluwarsa. Silakan coba lagi.',
      });
    }

    // 3. Lowongan harus aktif.
    const posting = await this.prisma.jobPosting.findUnique({
      where: { id: dto.postingId },
      select: { id: true, title: true, isActive: true, publishedAt: true, closedAt: true },
    });
    if (!posting || !posting.isActive || !posting.publishedAt || posting.closedAt) {
      throw new NotFoundException({
        code: ErrorCodes.POSTING_NOT_FOUND,
        message: 'Lowongan tidak ditemukan atau sudah ditutup.',
      });
    }

    // 4. Konsumsi cvFileKey (one-time, TTL 1 jam, hanya dari endpoint upload-cv).
    const issuedAt = this.pendingCvKeys.get(dto.cvFileKey);
    this.pendingCvKeys.delete(dto.cvFileKey);
    if (!issuedAt || Date.now() - issuedAt > CV_PENDING_TTL_MS) {
      throw new GoneException({
        code: ErrorCodes.CV_EXPIRED,
        message: 'File CV sudah kedaluwarsa atau sudah dipakai. Silakan upload ulang CV kamu.',
      });
    }

    // 5. Satu lamaran AKTIF per email per lowongan. Pelamar DITOLAK boleh
    //    melamar lagi (keputusan user 3 Okt 2026) — DITERIMA tetap diblokir.
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.jobApplication.findFirst({
      where: { postingId: dto.postingId, email },
      select: { id: true, status: true },
    });
    if (existing && existing.status !== JobApplicationStatus.DITOLAK) {
      throw new ConflictException({
        code: ErrorCodes.ALREADY_APPLIED,
        message: 'Email ini sudah melamar posisi tersebut dan lamaran masih aktif.',
      });
    }

    // 6. Token hapus-mandiri: 32 byte acak → simpan HANYA hash bcrypt.
    //    Token mentah tampil SEKALI di response; tidak pernah di-log/disimpan.
    const deletionToken = randomBytes(32).toString('hex');
    const deletionTokenHash = await bcrypt.hash(deletionToken, 10);

    const application = await this.prisma.$transaction(async (tx) => {
      const app = await tx.jobApplication.create({
        data: {
          postingId: dto.postingId,
          fullName: dto.fullName.trim(),
          email,
          phone: dto.phone.trim(),
          coverNote: dto.coverNote?.trim() || null,
          cvFileKey: dto.cvFileKey,
          portfolioUrl: dto.portfolioUrl?.trim() || null,
          status: JobApplicationStatus.BARU,
          deletionTokenHash,
        },
        select: { id: true },
      });
      await tx.jobApplicationStatusHistory.create({
        data: {
          applicationId: app.id,
          fromStatus: null,
          toStatus: JobApplicationStatus.BARU,
          changedBy: null, // sistem (submit pelamar)
        },
      });
      return app;
    });

    // 8. Email konfirmasi — fail-closed: skip + warn bila SMTP/queue belum siap.
    await this.sendCareerEmail(email, CAREER_EMAIL_TEMPLATES.APPLICATION_RECEIVED, {
      fullName: dto.fullName.trim(),
      jobTitle: posting.title,
    });

    return { id: application.id, deletionToken };
  }

  // ── Hapus-mandiri via deletion token (publik) ────────────────────────────

  async deleteApplicationByToken(id: string, token: string): Promise<{ deleted: boolean }> {
    const app = await this.prisma.jobApplication.findUnique({ where: { id } });
    if (!app) {
      throw new NotFoundException({
        code: ErrorCodes.APPLICATION_NOT_FOUND,
        message: 'Lamaran tidak ditemukan.',
      });
    }
    // bcrypt.compare = perbandingan timing-safe; token mentah tidak di-log.
    const valid = await bcrypt.compare(token, app.deletionTokenHash);
    if (!valid) {
      throw new ForbiddenException({
        code: ErrorCodes.INVALID_DELETION_TOKEN,
        message: 'Token penghapusan tidak valid.',
      });
    }
    // Hapus file CV (best-effort) lalu hard delete lamaran + history (cascade).
    await this.uploadService.deleteStoredFile(app.cvFileKey);
    await this.prisma.jobApplication.delete({ where: { id } });
    return { deleted: true };
  }

  // ── Admin: kelola lowongan ───────────────────────────────────────────────

  /**
   * Konvensi paginasi AW-019: { data, total, page, limit, totalPages }.
   */
  async listPostingsAdmin(params: { page: number; limit: number; active?: boolean }) {
    const { page, limit, active } = params;
    const where = active === undefined ? {} : { isActive: active };
    const [total, postings] = await this.prisma.$transaction([
      this.prisma.jobPosting.count({ where }),
      this.prisma.jobPosting.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { _count: { select: { applications: true } } },
      }),
    ]);
    return {
      data: postings.map((p) => ({
        ...p,
        applicationCount: p._count.applications,
        _count: undefined,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async createPosting(dto: CreateJobPostingDto, adminId: string) {
    const slug = (dto.slug?.trim() || slugify(dto.title)).slice(0, 128);
    const taken = await this.prisma.jobPosting.findUnique({ where: { slug }, select: { id: true } });
    if (taken) {
      throw new ConflictException({
        code: ErrorCodes.SLUG_ALREADY_USED,
        message: 'Slug sudah dipakai lowongan lain.',
      });
    }
    return this.prisma.jobPosting.create({
      data: {
        slug,
        title: dto.title.trim(),
        location: dto.location.trim(),
        type: dto.type.trim(),
        equity: dto.equity.trim(),
        summary: dto.summary.trim(),
        description: dto.description,
        requirements: dto.requirements ?? [],
        isActive: dto.isActive ?? true,
        publishedAt: dto.isActive === false ? null : new Date(),
        sortOrder: dto.sortOrder ?? 0,
        createdBy: adminId,
      },
    });
  }

  async updatePosting(id: string, dto: UpdateJobPostingDto) {
    const posting = await this.prisma.jobPosting.findUnique({ where: { id } });
    if (!posting) {
      throw new NotFoundException({
        code: ErrorCodes.POSTING_NOT_FOUND,
        message: 'Lowongan tidak ditemukan.',
      });
    }
    if (dto.slug && dto.slug !== posting.slug) {
      const taken = await this.prisma.jobPosting.findUnique({
        where: { slug: dto.slug },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException({
          code: ErrorCodes.SLUG_ALREADY_USED,
          message: 'Slug sudah dipakai lowongan lain.',
        });
      }
    }
    const data: Prisma.JobPostingUpdateInput = {};
    if (dto.slug !== undefined) data.slug = dto.slug.trim();
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.location !== undefined) data.location = dto.location.trim();
    if (dto.type !== undefined) data.type = dto.type.trim();
    if (dto.equity !== undefined) data.equity = dto.equity.trim();
    if (dto.summary !== undefined) data.summary = dto.summary.trim();
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.requirements !== undefined) data.requirements = dto.requirements;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) {
      data.isActive = dto.isActive;
      // Menutup lowongan → set closedAt; membuka kembali → reset closedAt.
      data.closedAt = dto.isActive ? null : new Date();
      if (dto.isActive && !posting.publishedAt) data.publishedAt = new Date();
    }
    return this.prisma.jobPosting.update({ where: { id }, data });
  }

  async deletePosting(id: string): Promise<{ deleted: boolean }> {
    const posting = await this.prisma.jobPosting.findUnique({
      where: { id },
      select: { id: true, _count: { select: { applications: true } } },
    });
    if (!posting) {
      throw new NotFoundException({
        code: ErrorCodes.POSTING_NOT_FOUND,
        message: 'Lowongan tidak ditemukan.',
      });
    }
    if (posting._count.applications > 0) {
      throw new ConflictException({
        code: ErrorCodes.DELETE_BLOCKED_HAS_APPLICATIONS,
        message: 'Lowongan masih memiliki lamaran. Tutup lowongan via nonaktifkan, bukan hapus.',
      });
    }
    await this.prisma.jobPosting.delete({ where: { id } });
    return { deleted: true };
  }

  // ── Admin: kelola lamaran ────────────────────────────────────────────────

  async listApplicationsAdmin(params: {
    page: number;
    limit: number;
    postingId?: string;
    status?: JobApplicationStatus;
    q?: string;
  }) {
    const { page, limit, postingId, status, q } = params;
    if (status && !Object.values(JobApplicationStatus).includes(status)) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Status tidak valid.',
      });
    }
    const where: Prisma.JobApplicationWhereInput = {};
    if (postingId) where.postingId = postingId;
    if (status) where.status = status;
    if (q && q.trim()) {
      where.OR = [
        { fullName: { contains: q.trim(), mode: 'insensitive' } },
        { email: { contains: q.trim(), mode: 'insensitive' } },
      ];
    }
    const [total, applications] = await this.prisma.$transaction([
      this.prisma.jobApplication.count({ where }),
      this.prisma.jobApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { posting: { select: { id: true, slug: true, title: true } } },
      }),
    ]);
    // Konvensi paginasi AW-019: { data, total, page, limit, totalPages }.
    return {
      data: applications,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getApplicationAdmin(id: string) {
    const app = await this.prisma.jobApplication.findUnique({
      where: { id },
      include: {
        posting: { select: { id: true, slug: true, title: true } },
        history: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!app) {
      throw new NotFoundException({
        code: ErrorCodes.APPLICATION_NOT_FOUND,
        message: 'Lamaran tidak ditemukan.',
      });
    }
    // CV privat: akses baca HANYA via signed URL HMAC kedaluwarsa 15 menit.
    const { downloadUrl, expiresAt } = this.uploadService.createSignedDownloadUrl(app.cvFileKey, 900);
    const { deletionTokenHash: _hash, ...rest } = app;
    return { ...rest, cvDownloadUrl: downloadUrl, cvDownloadExpiresAt: expiresAt };
  }

  async updateApplicationStatus(id: string, dto: UpdateApplicationStatusDto, adminId: string) {
    const app = await this.prisma.jobApplication.findUnique({
      where: { id },
      include: { posting: { select: { title: true } } },
    });
    if (!app) {
      throw new NotFoundException({
        code: ErrorCodes.APPLICATION_NOT_FOUND,
        message: 'Lamaran tidak ditemukan.',
      });
    }
    if (app.status === dto.status) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS_TRANSITION,
        message: 'Status sudah sama — tidak ada perubahan.',
      });
    }
    const allowed = ALLOWED_STATUS_TRANSITIONS[app.status] ?? [];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS_TRANSITION,
        message: `Transisi status ${app.status} → ${dto.status} tidak diizinkan.`,
      });
    }
    const isTerminal = app.status === JobApplicationStatus.DITERIMA || app.status === JobApplicationStatus.DITOLAK;
    if (isTerminal && (!dto.note || dto.note.trim() === '')) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_STATUS_TRANSITION,
        message: 'Membuka ulang lamaran terminal (DITERIMA/DITOLAK) wajib disertai catatan.',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedApp = await tx.jobApplication.update({
        where: { id },
        data: {
          status: dto.status,
          internalNote: dto.internalNote !== undefined ? dto.internalNote : undefined,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
      });
      await tx.jobApplicationStatusHistory.create({
        data: {
          applicationId: id,
          fromStatus: app.status,
          toStatus: dto.status,
          changedBy: adminId,
          note: dto.note?.trim() || null,
        },
      });
      return updatedApp;
    });

    // Notifikasi email ke pelamar (fail-closed bila SMTP belum siap).
    const template = STATUS_EMAIL_TEMPLATE[dto.status];
    if (template) {
      const context: CareerEmailContext = {
        fullName: app.fullName,
        jobTitle: app.posting.title,
      };
      if (dto.status === JobApplicationStatus.WAWANCARA && dto.note?.trim()) {
        context.interviewNote = dto.note.trim();
      }
      await this.sendCareerEmail(app.email, template, context);
    }

    return updated;
  }

  async deleteApplicationAdmin(id: string): Promise<{ deleted: boolean }> {
    const app = await this.prisma.jobApplication.findUnique({ where: { id } });
    if (!app) {
      throw new NotFoundException({
        code: ErrorCodes.APPLICATION_NOT_FOUND,
        message: 'Lamaran tidak ditemukan.',
      });
    }
    await this.uploadService.deleteStoredFile(app.cvFileKey);
    await this.prisma.jobApplication.delete({ where: { id } });
    return { deleted: true };
  }

  // ── Email (fail-closed) ──────────────────────────────────────────────────

  private smtpConfigured(): boolean {
    const host = this.configService.get<string>('smtp.host');
    const user = this.configService.get<string>('smtp.user');
    return !!host && !!user;
  }

  private async sendCareerEmail(
    to: string,
    template: CareerEmailTemplate,
    context: CareerEmailContext,
  ): Promise<void> {
    if (!this.smtpConfigured()) {
      this.logger.warn(
        `Email karir "${template}" ke ${to} DILEWATI: SMTP belum terkonfigurasi (fail-closed, bukan error).`,
      );
      return;
    }
    await enqueueCareerEmail(this.emailQueue, this.logger, to, template, context);
  }
}
