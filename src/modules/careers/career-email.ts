import { Logger } from '@nestjs/common';
import { Queue } from 'bull';
import { EmailJobData } from '../queue/processors/email.processor';

/**
 * Kontrak template email karir (karir.kahade.id) — FASE 3.
 *
 * Template (.hbs) TIDAK tahu soal pengiriman. Satu-satunya cara memakai
 * template ini adalah via `enqueueCareerEmail()` di bawah, yang mendorong
 * job ke email queue (Bull). Worker `EmailProcessor` me-render template
 * via TemplateService (allowlist) lalu mengirim via SMTP.
 *
 * Bila SMTP belum terverifikasi, JANGAN panggil helper ini — skip pengiriman
 * dan catat di log (fail-closed, jangan asal klaim terkirim).
 */

export const CAREER_EMAIL_TEMPLATES = {
  /** Konfirmasi lamaran masuk. Konteks: { fullName, jobTitle } */
  APPLICATION_RECEIVED: 'career-application-received',
  /** Status → DIREVIEW. Konteks: { fullName, jobTitle } */
  STATUS_REVIEW: 'career-status-review',
  /** Status → WAWANCARA. Konteks: { fullName, jobTitle, interviewNote? } */
  STATUS_INTERVIEW: 'career-status-interview',
  /** Status → DITERIMA. Konteks: { fullName, jobTitle, nextSteps? } */
  STATUS_ACCEPTED: 'career-status-accepted',
  /** Status → DITOLAK. Konteks: { fullName, jobTitle, supportEmail? } */
  STATUS_REJECTED: 'career-status-rejected',
} as const;

export type CareerEmailTemplate =
  (typeof CAREER_EMAIL_TEMPLATES)[keyof typeof CAREER_EMAIL_TEMPLATES];

export interface CareerEmailContext {
  fullName: string;
  jobTitle: string;
  /** Catatan jadwal wawancara (opsional, dari admin). */
  interviewNote?: string;
  /** Langkah berikutnya untuk yang diterima (opsional, dari admin). */
  nextSteps?: string;
  /** Email kontak bila token penghapusan hilang (opsional). */
  supportEmail?: string;
  /** Base URL halaman karir (default https://karir.kahade.id). */
  careerUrl?: string;
}

export const DEFAULT_CAREER_URL = 'https://karir.kahade.id';

const SUBJECTS: Record<CareerEmailTemplate, (ctx: CareerEmailContext) => string> = {
  [CAREER_EMAIL_TEMPLATES.APPLICATION_RECEIVED]: (c) =>
    `Lamaran ${c.jobTitle} sudah kami terima — Kahade`,
  [CAREER_EMAIL_TEMPLATES.STATUS_REVIEW]: (c) =>
    `Lamaran ${c.jobTitle} sedang kami tinjau — Kahade`,
  [CAREER_EMAIL_TEMPLATES.STATUS_INTERVIEW]: (c) =>
    `Undangan wawancara ${c.jobTitle} — Kahade`,
  [CAREER_EMAIL_TEMPLATES.STATUS_ACCEPTED]: (c) =>
    `Selamat! Kamu diterima sebagai ${c.jobTitle} — Kahade`,
  [CAREER_EMAIL_TEMPLATES.STATUS_REJECTED]: (c) =>
    `Update lamaran ${c.jobTitle} — Kahade`,
};

const QUEUE_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};

/**
 * Antrekan email karir. Tidak melempar — kegagalan dicatat di log saja
 * (pengiriman email tidak boleh menggagalkan alur lamaran).
 */
export async function enqueueCareerEmail(
  emailQueue: Queue<EmailJobData> | undefined,
  logger: Logger,
  to: string,
  template: CareerEmailTemplate,
  context: CareerEmailContext,
): Promise<void> {
  if (!emailQueue) {
    logger.warn(
      `Career email "${template}" to ${to} skipped: email queue not available`,
    );
    return;
  }
  const jobData: EmailJobData = {
    to,
    subject: SUBJECTS[template](context),
    templateName: template,
    templateContext: { careerUrl: DEFAULT_CAREER_URL, ...context },
  };
  await emailQueue
    .add('send', jobData, QUEUE_JOB_OPTIONS)
    .catch((err: unknown) => {
      logger.error(
        `Failed to queue career email "${template}" to ${to}`,
        err as Error,
      );
    });
}
