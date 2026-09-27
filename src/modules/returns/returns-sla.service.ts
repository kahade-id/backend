/**
 * GAP-D retur — scheduler (G208, G222).
 *
 * Self-contained di modul returns (tidak menyentuh scheduler.module existing).
 * - Tiap 30 menit: eskalasi otomatis bila seller melewati SLA respons.
 * - Tiap jam: kedaluwarsakan kirim-balik & klarifikasi yang basi.
 * - Tiap hari 03:00 WIB: purge lampiran melewati masa retensi.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReturnsService } from './returns.service';

@Injectable()
export class ReturnsSlaService {
  private readonly logger = new Logger(ReturnsSlaService.name);

  constructor(private returnsService: ReturnsService) {}

  @Cron('*/30 * * * *', { name: 'returns-seller-sla' })
  async handleSellerSla(): Promise<void> {
    try {
      const n = await this.returnsService.expireSellerSla();
      if (n > 0) this.logger.log(`returns-seller-sla: ${n} case dieskalasi otomatis`);
    } catch (err) {
      this.logger.error(`returns-seller-sla gagal: ${(err as Error).message}`);
    }
  }

  @Cron('0 * * * *', { name: 'returns-stale-expiry' })
  async handleStaleExpiry(): Promise<void> {
    try {
      const n = await this.returnsService.expireStale();
      if (n > 0) this.logger.log(`returns-stale-expiry: ${n} case kedaluwarsa`);
    } catch (err) {
      this.logger.error(`returns-stale-expiry gagal: ${(err as Error).message}`);
    }
  }

  @Cron('0 3 * * *', { name: 'returns-evidence-purge', timeZone: 'Asia/Jakarta' })
  async handleEvidencePurge(): Promise<void> {
    try {
      const n = await this.returnsService.purgeExpiredEvidence();
      if (n > 0) this.logger.log(`returns-evidence-purge: ${n} lampiran di-purge`);
    } catch (err) {
      this.logger.error(`returns-evidence-purge gagal: ${(err as Error).message}`);
    }
  }
}
