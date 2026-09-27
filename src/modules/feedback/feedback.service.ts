import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFeedbackDto } from './dto/create-feedback.dto';

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Simpan feedback. `userId` null untuk guest (auth opsional) — kolom
   * userId di DB nullable dengan onDelete SetNull.
   */
  async create(userId: string | null, dto: CreateFeedbackDto): Promise<object> {
    // G168: hitung slaDueAt dari rule kategori bila ada.
    const rule = await this.prisma.feedbackSlaRule.findUnique({
      where: { category: dto.category.trim() },
    });
    const now = new Date();
    const feedback = await this.prisma.feedback.create({
      data: {
        userId: userId ?? undefined,
        category: dto.category.trim(),
        message: dto.message.trim(),
        contact: dto.contact?.trim() ? dto.contact.trim() : undefined,
        rating: dto.rating ?? undefined,
        platform: dto.platform?.trim() ? dto.platform.trim() : 'app',
        contactConsent: dto.contactConsent ?? false,
        appVersion: dto.appVersion?.trim() ? dto.appVersion.trim() : undefined,
        slaDueAt: rule ? new Date(now.getTime() + rule.hours * 3_600_000) : undefined,
      },
      select: { id: true, createdAt: true, slaDueAt: true },
    });
    this.logger.log(`Feedback tersimpan id=${feedback.id} userId=${userId ?? 'guest'}`);
    return {
      success: true,
      data: { id: feedback.id, createdAt: feedback.createdAt, slaDueAt: feedback.slaDueAt },
    };
  }
}
