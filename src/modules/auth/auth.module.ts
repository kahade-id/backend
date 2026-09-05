import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { OtpService } from './otp.service';
import { CaptchaService } from './captcha.service';
import { OtpGatewayService } from './otp-gateway.service';
import { QueueModule } from '../queue/queue.module';
import { AuditLogModule } from '../../common/services/audit-log.module';

@Global()
@Module({
  imports: [
    JwtModule.register({}),
    QueueModule,
    AuditLogModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, OtpService, CaptchaService, OtpGatewayService],
  exports: [AuthService, TokenService, OtpService, CaptchaService, OtpGatewayService, JwtModule],
})
export class AuthModule {}
