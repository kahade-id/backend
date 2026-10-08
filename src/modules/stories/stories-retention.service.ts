import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StoriesService } from './stories.service';

@Injectable()
export class StoriesRetentionService {
  private readonly logger = new Logger(StoriesRetentionService.name);

  constructor(private readonly stories: StoriesService) {}

  @Cron('*/10 * * * *', { name: 'story-retention', timeZone: 'UTC' })
  async run(): Promise<void> {
    const result = await this.stories.cleanupExpiredAndRetained().catch((error: unknown) => {
      this.logger.error(
        `Story retention job failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    if (result && (result.expired || result.deleted || result.mediaTickets)) {
      this.logger.log(
        `Story retention processed: expired events=${result.expired}, hard-deleted=${result.deleted}, expired upload tickets=${result.mediaTickets}`,
      );
    }
  }
}
