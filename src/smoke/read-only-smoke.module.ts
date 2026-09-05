import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig, cryptoConfig, databaseConfig, fcmConfig, jwtConfig, midtransConfig, r2Config, redisConfig, smtpConfig } from '../config';
import { validateEnv } from '../config/env.validation';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { HealthModule } from '../modules/health/health.module';
import { getSmokeEnvFile } from './bootstrap-mode';

const smokeEnvFile = getSmokeEnvFile();

/**
 * An intentionally narrow root graph for an isolated candidate process.
 *
 * Do not add feature modules here. In particular, queue, scheduler, payment,
 * notification, websocket, and transaction modules can enqueue work or mutate
 * production state merely by booting with shared infrastructure credentials.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: smokeEnvFile,
      load: [appConfig, databaseConfig, jwtConfig, cryptoConfig, redisConfig, midtransConfig, r2Config, smtpConfig, fcmConfig],
      validate: validateEnv,
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
  ],
})
export class ReadOnlySmokeModule {}
