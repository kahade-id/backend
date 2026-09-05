import { Processor, Process, OnQueueFailed, OnQueueCompleted } from '@nestjs/bull';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { RedisService } from '../../../redis/redis.service';
import { TemplateService } from '../../../common/services/template.service';
import { DEAD_LETTER_QUEUE, deadLetterJobId, QUEUE_JOB_TIMEOUT_MS } from '../queue.constants';
import { safeErrorMessage } from '../../../common/utils/background-reliability.util';

export const EMAIL_QUEUE = 'email';

const PERMANENT_ERROR_PATTERNS = [
  /invalid.*(?:email|address|recipient|mailbox)/i,
  /user.*(?:unknown|not found|does not exist)/i,
  /mailbox.*(?:not found|unavailable|disabled|full)/i,
  /address.*rejected/i,
  /no such user/i,
  /account.*(?:disabled|suspended|closed)/i,
  /domain.*(?:not found|invalid)/i,
  /relay.*denied/i,
  /blacklisted/i,
  /spam.*rejected/i,
  /policy.*rejection/i,
  /permanent.*failure/i,
];

const PERMANENT_SMTP_CODES = new Set([
  550, 551, 552, 553, 554,
  521, 525, 541, 571,
]);

function isPermanentFailure(error: Error): boolean {
  const message = error.message || '';
  if (PERMANENT_ERROR_PATTERNS.some(p => p.test(message))) {
    return true;
  }

  const codeMatch = message.match(/\b([45]\d{2})\b/);
  if (codeMatch) {
    const code = parseInt(codeMatch[1], 10);
    if (PERMANENT_SMTP_CODES.has(code)) {
      return true;
    }
  }

  const responseCode =
    error && typeof error === 'object'
      ? (error as { responseCode?: unknown }).responseCode
      : undefined;
  if (typeof responseCode === 'number' && PERMANENT_SMTP_CODES.has(responseCode)) {
    return true;
  }

  return false;
}

function htmlToPlainText(html: string): string {
  let text = html;
  text = text.replace(/<\/?(p|br|div|h[1-6]|li|tr|blockquote|hr)[^>]*>/gi, '\n');
  text = text.replace(/<\/(td|th)>/gi, '\t');
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)');
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+$/gm, '');
  return text.trim();
}

export interface EmailJobData {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  templateName?: string;
  templateContext?: Record<string, unknown>;
}

const MAX_EMAIL_LENGTH = 254;
const MAX_SUBJECT_LENGTH = 998;
const MAX_HTML_LENGTH = 1_000_000;

function isValidEmailJobData(data: unknown): data is EmailJobData {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  const hasHtml = typeof d.html === 'string' && d.html.length > 0 && d.html.length <= MAX_HTML_LENGTH;
  const hasTemplate = typeof d.templateName === 'string' && d.templateName.length > 0;
  return (
    typeof d.to === 'string' && d.to.length > 0 && d.to.length <= MAX_EMAIL_LENGTH &&
    typeof d.subject === 'string' && d.subject.length > 0 && d.subject.length <= MAX_SUBJECT_LENGTH &&
    (hasHtml || hasTemplate)
  );
}

@Injectable()
@Processor(EMAIL_QUEUE)
export class EmailProcessor implements OnModuleDestroy {
  private readonly logger = new Logger(EmailProcessor.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(
    private configService: ConfigService,
    private redisService: RedisService,
    private templateService: TemplateService,
    @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetterQueue: Queue,
  ) {}

  onModuleDestroy(): void {
    this.transporter?.close();
  }

  private getTransporter(): nodemailer.Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.configService.get<string>('smtp.host'),
        port: this.configService.get<number>('smtp.port') || 587,
        secure: this.configService.get<boolean>('smtp.secure') || false,
        auth: {
          user: this.configService.get<string>('smtp.user'),
          pass: this.configService.get<string>('smtp.pass'),
        },
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: QUEUE_JOB_TIMEOUT_MS,
      });
    }
    return this.transporter;
  }

  @Process({ name: 'send', concurrency: 3 })
  async handleSendEmail(job: Job<EmailJobData>): Promise<void> {
    if (!isValidEmailJobData(job.data)) {
      throw new Error(`Email job ${job.id} has invalid payload shape or exceeds field length limits`);
    }

    const { to, subject, text } = job.data;
    this.logger.log(`Processing email job ${job.id}`);

    let html: string;
    if (job.data.templateName) {
      try {
        const ctx = { ...job.data.templateContext, subject, year: new Date().getFullYear() };
        html = this.templateService.render(job.data.templateName, ctx);
      } catch (templateError) {
        this.logger.error(`Email job ${job.id} template rendering failed for "${job.data.templateName}": ${(templateError as Error).message}`);
        await job.moveToFailed({ message: `Template rendering failed: ${(templateError as Error).message}` }, true);
        return;
      }
    } else {
      html = (job.data as { html: string }).html;
    }

    try {
      const transporter = this.getTransporter();
      await transporter.sendMail({
        from: this.configService.get<string>('smtp.from') || this.configService.get<string>('smtp.fromAddress') || '',
        to,
        subject,
        html,
        text: text || htmlToPlainText(html),
      });

      this.logger.log(`Email job ${job.id} sent successfully`);
    } catch (error) {
      if (error instanceof Error && isPermanentFailure(error)) {
        this.logger.warn(
          `Email job ${job.id} permanent failure (skipping retries): ${error.message}`,
        );
        await job.moveToFailed(
          { message: `Permanent failure: ${error.message}` },
          true,
        );
        return;
      }
      throw error;
    }
  }

  @OnQueueFailed()
  async onJobFailed(job: Job<EmailJobData>, error: Error): Promise<void> {
    const sanitizedMessage = safeErrorMessage(error)
      .replace(/pass(?:word)?[:=]\s*\S+/gi, 'pass:[REDACTED]')
      .replace(/user[:=]\s*\S+/gi, 'user:[REDACTED]')
      .replace(/auth(?:entication)?.*?failed/gi, 'authentication failed');
    const errorType = isPermanentFailure(error) ? 'PERMANENT' : 'TRANSIENT';
    this.logger.error(
      `Email job ${job.id} FAILED [${errorType}] (attempt ${job.attemptsMade}/${job.opts.attempts}): ${sanitizedMessage}`,
    );


    if (job.attemptsMade >= (job.opts.attempts || 1)) {
      const failureData = {
        jobId: job.id,
        error: sanitizedMessage,
        errorType,
        failedAt: new Date().toISOString(),
      };
      await this.redisService.hset('email_queue_failures', job.id.toString(), JSON.stringify(failureData));
      await this.redisService.expire('email_queue_failures', 7 * 24 * 60 * 60);

      await this.deadLetterQueue.add('email-failed', {
        originalQueue: EMAIL_QUEUE,
        jobId: job.id,
        data: { to: job.data.to, subject: job.data.subject, templateName: job.data.templateName },
        error: sanitizedMessage,
        errorType,
        failedAt: new Date().toISOString(),
      }, {
        jobId: deadLetterJobId(EMAIL_QUEUE, job.id),
        removeOnComplete: false,
        removeOnFail: false,
      }).catch((dlqErr: unknown) => {
        this.logger.error(`CRITICAL: Dead-letter queue enqueue failed for email job ${job.id} — event lost`, dlqErr);
      });
    }
  }

  @OnQueueCompleted()
  onJobCompleted(job: Job<EmailJobData>): void {
    this.logger.debug(`Email job ${job.id} completed after ${job.attemptsMade} attempt(s)`);
  }
}
