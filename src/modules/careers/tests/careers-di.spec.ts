import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { PrismaModule } from '../../../prisma/prisma.module';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { UploadService } from '../../upload/upload.service';
import { UploadModule } from '../../upload/upload.module';
import { QueueModule } from '../../queue/queue.module';
import { EMAIL_QUEUE } from '../../queue/processors/email.processor';
import { CareersModule } from '../careers.module';
import { CareersService } from '../careers.service';
import { CareerCaptchaService } from '../captcha.service';
import { CareersController } from '../careers.controller';
import { AdminCareersController } from '../admin-careers.controller';
import { CareersRetentionService } from '../careers-retention.service';

/**
 * DI smoke test modul careers.
 *
 * QueueModule (Bull) & UploadModule asli di-override dengan modul fake —
 * di sandbox ini tidak ada Redis, dan @nestjs/bull membuat antrean nyata
 * menggantung saat compile. Yang diverifikasi: graph dependency
 * CareersModule sendiri (controller, provider, token EMAIL_QUEUE,
 * PrismaService global, ConfigService global) ter-resolve tanpa error.
 */
@Module({
  providers: [{ provide: getQueueToken(EMAIL_QUEUE), useValue: { add: jest.fn() } }],
  exports: [getQueueToken(EMAIL_QUEUE)],
})
class FakeQueueModule {}

@Module({
  providers: [{ provide: UploadService, useValue: {} }],
  exports: [UploadService],
})
class FakeUploadModule {}

describe('CareersModule DI', () => {
  it('mengompilasi dependency injection tanpa error', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, CareersModule],
    })
      .overrideModule(QueueModule)
      .useModule(FakeQueueModule)
      .overrideModule(UploadModule)
      .useModule(FakeUploadModule)
      .overrideGuard(JwtAdminGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AdminRolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    expect(moduleRef.get(CareersService)).toBeDefined();
    expect(moduleRef.get(CareerCaptchaService)).toBeDefined();
    expect(moduleRef.get(CareersController)).toBeDefined();
    expect(moduleRef.get(AdminCareersController)).toBeDefined();
    expect(moduleRef.get(CareersRetentionService)).toBeDefined();
    // ConfigService global tersedia untuk smtpConfigured().
    expect(moduleRef.get(ConfigService)).toBeDefined();
  }, 60000);
});
