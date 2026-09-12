import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Section 6 — agregasi laporan menjadi sinyal moderasi.
 *
 * Ambang: >= 3 laporan dari reporter BERBEDA dalam jendela 24 jam untuk satu
 * target. "Reporter berbeda" itu penting: satu orang yang melaporkan sepuluh
 * kali tidak boleh bisa menflag siapapun, dan cooldown 24 jam per
 * (reporter, target) di jalur laporan sudah membatasi itu di sisi hulu.
 *
 * Yang TIDAK dilakukan layanan ini (disengaja):
 *   - tidak men-ban, men-suspend, atau membatasi fitur target;
 *   - tidak menulis notifikasi ke target;
 *   - tidak pernah mengekspos flag ke user lain.
 * Flag murni penanda antrean review; keputusan tetap milik admin.
 */
export const REPORT_FLAG_THRESHOLD = 3;
export const REPORT_FLAG_WINDOW_HOURS = 24;

@Injectable()
export class ReportFlagService {
  private readonly logger = new Logger(ReportFlagService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mengevaluasi ulang satu target setelah sebuah laporan tersimpan.
   *
   * Best-effort by contract: method ini TIDAK PERNAH melempar. Dipanggil
   * sesudah `userReport.create` berhasil, sehingga kegagalan agregasi tidak
   * boleh membatalkan laporan yang sudah sah tersimpan — laporan jauh lebih
   * penting daripada flag-nya, dan tick berikutnya akan menghitung ulang
   * begitu ada laporan baru untuk target yang sama.
   */
  async evaluateTarget(targetId: string): Promise<{ flaggedForReview: boolean; distinctReporters: number }> {
    try {
      const since = new Date(Date.now() - REPORT_FLAG_WINDOW_HOURS * 60 * 60 * 1000);
      const reporters = await this.prisma.userReport.findMany({
        where: { targetId, createdAt: { gte: since } },
        select: { reporterId: true },
        distinct: ['reporterId'],
      });
      const distinctReporters = reporters.length;

      if (distinctReporters < REPORT_FLAG_THRESHOLD) {
        return { flaggedForReview: false, distinctReporters };
      }

      // updateMany bersyarat `flaggedForReview: false`: idempoten, jadi laporan
      // ke-4, ke-5, dst. tidak menggeser timestamp. flaggedForReviewAt menandai
      // kapan ambang PERTAMA kali terlampaui.
      const claimed = await this.prisma.user.updateMany({
        where: { id: targetId, flaggedForReview: false, deletedAt: null },
        data: { flaggedForReview: true, flaggedForReviewAt: new Date() },
      });

      if (claimed.count > 0) {
        this.logger.warn(
          `User ${targetId} flagged for review — ${distinctReporters} distinct reporter(s) in the last ${REPORT_FLAG_WINDOW_HOURS}h (no automatic action taken)`,
        );
      }
      return { flaggedForReview: true, distinctReporters };
    } catch (error: unknown) {
      this.logger.error(
        `Report flag evaluation failed for target ${targetId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { flaggedForReview: false, distinctReporters: 0 };
    }
  }
}
