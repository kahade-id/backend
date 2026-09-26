import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { LegacyFonnteWebhookController } from './legacy-fonnte-webhook.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { OtpService } from './otp.service';
import { CaptchaService } from './captcha.service';
import { OtpGatewayService } from './otp-gateway.service';
import { OtpTriggerService } from './otp-trigger.service';
import { AuthLocationService } from './auth-location.service';
import { QueueModule } from '../queue/queue.module';
import { AuditLogModule } from '../../common/services/audit-log.module';

@Global()
@Module({
  imports: [
    JwtModule.register({}),
    QueueModule,
    AuditLogModule,
  ],
  controllers: [AuthController, LegacyFonnteWebhookController],
  providers: [
    AuthService,
    TokenService,
    OtpService,
    CaptchaService,
    OtpGatewayService,
    OtpTriggerService,
    AuthLocationService,
  ],
  exports: [AuthService, TokenService, OtpService, CaptchaService, OtpGatewayService, OtpTriggerService, AuthLocationService, JwtModule],
})
export class AuthModule {}
