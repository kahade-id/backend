import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FeedbackService } from './feedback.service';
import { CreateFeedbackDto } from './dto/create-feedback.dto';

@ApiTags('feedback')
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  /**
   * Terima feedback dari aplikasi. Auth opsional: user login terisi otomatis
   * via viewer-aware guard (request.user), guest tetap bisa mengirim.
   * Throttle 10/menit per IP untuk mencegah spam.
   */
  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Kirim feedback (auth opsional, guest didukung)' })
  async create(
    @CurrentUser('sub') userId: string | null,
    @Body() dto: CreateFeedbackDto,
  ): Promise<object> {
    return this.feedbackService.create(userId, dto);
  }
}
