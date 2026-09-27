import { Module, Global, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { LegacyFonnteWebhookController } from './legacy-fonnte-webhook.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { OtpService } from './otp.service';
import { CaptchaService } from './captcha.service';
import { OtpGatewayService } from './otp-gateway.service';
import { OtpTriggerService } from './otp-trigger.service';
import { AuthLocationService } from './auth-location.service';
import { PasskeyService } from './passkey.service';
import { PasskeyController } from './passkey.controller';
import { AppleAuthService } from './apple-auth.service';
import { QueueModule } from '../queue/queue.module';
import { AuditLogModule } from '../../common/services/audit-log.module';

@Global()
@Module({
  imports: [
    JwtModule.register({}),
    QueueModule,
    AuditLogModule,
    // AccountDeletionService dipakai AuthController — forwardRef agar aman
    // bila kelak ada siklus UsersModule <-> AuthModule.
    forwardRef(() => UsersModule),
  ],
  controllers: [AuthController, LegacyFonnteWebhookController, PasskeyController],
  providers: [
    AuthService,
    TokenService,
    OtpService,
    CaptchaService,
    OtpGatewayService,
    OtpTriggerService,
    AuthLocationService,
    PasskeyService,
    AppleAuthService,
  ],
  exports: [AuthService, TokenService, OtpService, CaptchaService, OtpGatewayService, OtpTriggerService, AuthLocationService, PasskeyService, AppleAuthService, JwtModule],
})
export class AuthModule {}
