/**
 * Kahade — metrik backlog queue Bull (G484 audit 2026-09-26).
 *
 * Menampilkan panjang antrean per queue: waiting, active, delayed, failed.
 * Queue yang dikenali: email, notification, audit-log, dead-letter.
 * CATATAN: tidak ada queue khusus OTP — pengiriman OTP (Fonnte/Twilio) saat
 * ini synchronous di otp-gateway; backlog OTP dipantau lewat alert
 * `otp_errors` (G485), bukan kedalaman queue. Bila OTP dipindah ke queue,
 * daftarkan namanya di KNOWN_QUEUES.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { EMAIL_QUEUE } from '../queue/processors/email.processor';
import { NOTIFICATION_QUEUE } from '../queue/processors/notification.processor';
import { AUDIT_LOG_QUEUE } from '../../common/services/audit-log.service';
import { DEAD_LETTER_QUEUE } from '../queue/queue.constants';

export interface QueueDepth {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  /** Total backlog (waiting + delayed + active). */
  backlog: number;
  available: boolean;
}

@Injectable()
export class QueueMetricsService {
  private readonly logger = new Logger(QueueMetricsService.name);

  constructor(
    @Optional() @InjectQueue(EMAIL_QUEUE) private readonly email?: Queue,
    @Optional() @InjectQueue(NOTIFICATION_QUEUE) private readonly notification?: Queue,
    @Optional() @InjectQueue(AUDIT_LOG_QUEUE) private readonly auditLog?: Queue,
    @Optional() @InjectQueue(DEAD_LETTER_QUEUE) private readonly deadLetter?: Queue,
  ) {}

  async getDepths(): Promise<QueueDepth[]> {
    const queues: Array<[string, Queue | undefined]> = [
      ['email', this.email],
      ['notification', this.notification],
      ['audit-log', this.auditLog],
      ['dead-letter', this.deadLetter],
    ];
    const out: QueueDepth[] = [];
    for (const [name, queue] of queues) {
      if (!queue) {
        out.push({ name, waiting: 0, active: 0, delayed: 0, failed: 0, backlog: 0, available: false });
        continue;
      }
      try {
        const [waiting, active, delayed, failed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getDelayedCount(),
          queue.getFailedCount(),
        ]);
        out.push({
          name, waiting, active, delayed, failed,
          backlog: waiting + active + delayed,
          available: true,
        });
      } catch (err) {
        this.logger.warn(`Queue depth read failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
        out.push({ name, waiting: 0, active: 0, delayed: 0, failed: 0, backlog: 0, available: false });
      }
    }
    return out;
  }
}
