import { Module } from '@nestjs/common';
import { UploadModule } from '../upload/upload.module';
import { QueueModule } from '../queue/queue.module';
import { CareersService } from './careers.service';
import { CareerCaptchaService } from './captcha.service';
import { CareersRetentionService } from './careers-retention.service';
import { CareersController } from './careers.controller';
import { AdminCareersController } from './admin-careers.controller';

/**
 * Modul karir (karir.kahade.id).
 * - CareersController: publik /v1/careers (tanpa auth)
 * - AdminCareersController: /v1/admin/careers (JwtAdminGuard + SUPER_ADMIN)
 * - CareersRetentionService: cron retensi 90 hari + janitor CV pending
 *
 * QueueModule diimpor agar @InjectQueue(EMAIL_QUEUE) tersedia (opsional —
 * email fail-closed bila queue/SMTP belum siap).
 */
@Module({
  imports: [UploadModule, QueueModule],
  controllers: [CareersController, AdminCareersController],
  providers: [CareersService, CareerCaptchaService, CareersRetentionService],
  exports: [CareersService],
})
export class CareersModule {}
