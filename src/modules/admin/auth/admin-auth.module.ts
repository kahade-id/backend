import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { TokenService } from '../../auth/token.service';
import { AuditLogModule } from '../../../common/services/audit-log.module';

@Module({
  imports: [JwtModule.register({}), ConfigModule, AuditLogModule],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, TokenService],
  exports: [AdminAuthService],
})
export class AdminAuthModule {}
