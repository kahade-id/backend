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
    const feedback = await this.prisma.feedback.create({
      data: {
        userId: userId ?? undefined,
        category: dto.category.trim(),
        message: dto.message.trim(),
        contact: dto.contact?.trim() ? dto.contact.trim() : undefined,
        rating: dto.rating ?? undefined,
        platform: dto.platform?.trim() ? dto.platform.trim() : 'app',
      },
      select: { id: true, createdAt: true },
    });
    this.logger.log(`Feedback tersimpan id=${feedback.id} userId=${userId ?? 'guest'}`);
    return {
      success: true,
      data: { id: feedback.id, createdAt: feedback.createdAt },
    };
  }
}
