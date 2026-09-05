import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

class TooManyRequestsException extends HttpException {
  constructor(message = 'Too many requests') {
    super({ message, statusCode: HttpStatus.TOO_MANY_REQUESTS }, HttpStatus.TOO_MANY_REQUESTS);
  }
}
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { OtpType, OtpMethod, Prisma } from '@prisma/client';
import { generateOtp, hashOtp, verifyOtp } from '../../common/utils/otp.util';
import { addMinutes } from '../../common/utils/date.util';
import { OTP_COOLDOWN, OTP_EMAIL_RATE, OTP_IP_RATE, OTP_PHONE_RATE } from '../../common/constants/redis-keys';
import { OTP_EXPIRES_MINUTES, OTP_MAX_ATTEMPTS } from '../../common/constants/app.constants';
import * as bcrypt from 'bcrypt';

const OTP_COOLDOWN_SECONDS = 60;
const OTP_EMAIL_RATE_LIMIT = 10;
const OTP_PHONE_RATE_LIMIT = 10;
const OTP_RATE_WINDOW_SECONDS = 3600;
const OTP_IP_RATE_LIMIT = 20;
const OTP_IP_RATE_WINDOW_SECONDS = 3600;
const DUMMY_OTP_HASH = '$2b$12$EixZaYVK1fsbw1ZfbX3OXePaWxn96p36WQoeG6Lruj3vjPGga31lW';

@Injectable()
export class OtpService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private configService: ConfigService,
  ) {}

  async generateOtp(
    email: string,
    type: OtpType,
    userId?: string,
    metadata?: Prisma.InputJsonValue,
    ipAddress?: string,
  ): Promise<string> {
    const cooldownKey = OTP_COOLDOWN(email, type);

    const cooldownClaimed = await this.redis.setNx(cooldownKey, '1', OTP_COOLDOWN_SECONDS);
    if (!cooldownClaimed) {
      throw new TooManyRequestsException(`Please wait ${OTP_COOLDOWN_SECONDS} seconds before requesting a new OTP`);
    }

    try {
      if (ipAddress) {
        const ipRateKey = OTP_IP_RATE(ipAddress);
        const ipCount = await this.redis.incr(ipRateKey);
        if (ipCount === 1) {
          await this.redis.expire(ipRateKey, OTP_IP_RATE_WINDOW_SECONDS);
        }
        if (ipCount > OTP_IP_RATE_LIMIT) {
          throw new TooManyRequestsException('Too many OTP requests from this IP. Please try again later.');
        }
      }

      const emailRateKey = OTP_EMAIL_RATE(email, type);
      const emailCount = await this.redis.incr(emailRateKey);
      if (emailCount === 1) {
        await this.redis.expire(emailRateKey, OTP_RATE_WINDOW_SECONDS);
      }
      if (emailCount > OTP_EMAIL_RATE_LIMIT) {
        throw new TooManyRequestsException('Too many OTP requests for this email. Please try again later.');
      }

      const otp = generateOtp(6);
      const hashedOtp = await hashOtp(otp);
      const otpMinutes = this.configService.get<number>('app.otpExpiresMinutes') ?? OTP_EXPIRES_MINUTES;
      const expiresAt = addMinutes(new Date(), otpMinutes);

      await this.prisma.$transaction(async (tx) => {
        await tx.otpCode.updateMany({
          where: { email, type, isUsed: false },
          data: { isUsed: true, usedAt: new Date() },
        });
        await tx.otpCode.create({
          data: { email, code: hashedOtp, type, userId, metadata: metadata || {}, expiresAt },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      return otp;
    } catch (error) {
      await this.redis.del(cooldownKey);
      throw error;
    }
  }

  async generatePhoneOtp(
    phone: string,
    type: OtpType,
    method: OtpMethod,
    userId?: string,
    metadata?: Prisma.InputJsonValue,
    ipAddress?: string,
  ): Promise<string> {
    const cooldownKey = OTP_COOLDOWN(phone, type);

    const cooldownClaimed = await this.redis.setNx(cooldownKey, '1', OTP_COOLDOWN_SECONDS);
    if (!cooldownClaimed) {
      throw new TooManyRequestsException(`Please wait ${OTP_COOLDOWN_SECONDS} seconds before requesting a new OTP`);
    }

    try {
      if (ipAddress) {
        const ipRateKey = OTP_IP_RATE(ipAddress);
        const ipCount = await this.redis.incr(ipRateKey);
        if (ipCount === 1) {
          await this.redis.expire(ipRateKey, OTP_IP_RATE_WINDOW_SECONDS);
        }
        if (ipCount > OTP_IP_RATE_LIMIT) {
          throw new TooManyRequestsException('Too many OTP requests from this IP. Please try again later.');
        }
      }

      const phoneRateKey = OTP_PHONE_RATE(phone, type);
      const phoneCount = await this.redis.incr(phoneRateKey);
      if (phoneCount === 1) {
        await this.redis.expire(phoneRateKey, OTP_RATE_WINDOW_SECONDS);
      }
      if (phoneCount > OTP_PHONE_RATE_LIMIT) {
        throw new TooManyRequestsException('Too many OTP requests for this phone number. Please try again later.');
      }

      const otp = generateOtp(6);
      const hashedOtp = await hashOtp(otp);
      const otpMinutes = this.configService.get<number>('app.otpExpiresMinutes') ?? OTP_EXPIRES_MINUTES;
      const expiresAt = addMinutes(new Date(), otpMinutes);

      await this.prisma.$transaction(async (tx) => {
        await tx.otpCode.updateMany({
          where: { phone, type, isUsed: false },
          data: { isUsed: true, usedAt: new Date() },
        });
        await tx.otpCode.create({
          data: { phone, code: hashedOtp, type, method, userId, metadata: metadata || {}, expiresAt },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      return otp;
    } catch (error) {
      await this.redis.del(cooldownKey);
      throw error;
    }
  }

  async verifyPhoneOtp(phone: string, type: OtpType, code: string): Promise<boolean> {
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const record = await tx.otpCode.findFirst({
        where: { phone, type, isUsed: false, expiresAt: { gt: now }, attempts: { lt: OTP_MAX_ATTEMPTS } },
        orderBy: { createdAt: 'desc' },
      });

      if (!record) {
        await bcrypt.compare('dummy_constant_time_sentinel', DUMMY_OTP_HASH);
        return false;
      }

      const bump = await tx.otpCode.updateMany({
        where: { id: record.id, isUsed: false, expiresAt: { gt: now }, attempts: { lt: OTP_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      if (bump.count === 0) return false;

      const isValid = await verifyOtp(code, record.code);
      if (!isValid) return false;

      const used = await tx.otpCode.updateMany({
        where: { id: record.id, isUsed: false },
        data: { isUsed: true, usedAt: new Date() },
      });
      if (used.count === 1) {
        return { verified: true, phone: record.phone, type: record.type };
      }
      return false;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return !!result;
  }

  async verifyPhoneOtpWithMetadata(
    phone: string,
    type: OtpType,
    code: string,
    options: { consume?: boolean } = {},
  ): Promise<{ valid: boolean; metadata?: Record<string, unknown>; otpId?: string }> {
    const now = new Date();
    const consume = options.consume !== false;

    const result = await this.prisma.$transaction(async (tx) => {
      const record = await tx.otpCode.findFirst({
        where: { phone, type, isUsed: false, expiresAt: { gt: now }, attempts: { lt: OTP_MAX_ATTEMPTS } },
        orderBy: { createdAt: 'desc' },
      });
      if (!record) {
        await bcrypt.compare('dummy_constant_time_sentinel', DUMMY_OTP_HASH);
        return null;
      }

      const bump = await tx.otpCode.updateMany({
        where: { id: record.id, isUsed: false, expiresAt: { gt: now }, attempts: { lt: OTP_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      if (bump.count === 0) return null;
      if (!await verifyOtp(code, record.code)) return null;

      if (!consume) {
        return { verified: true, otpId: record.id, metadata: record.metadata as Record<string, unknown> | null };
      }
      const used = await tx.otpCode.updateMany({
        where: { id: record.id, isUsed: false },
        data: { isUsed: true, usedAt: new Date() },
      });
      return used.count === 1
        ? { verified: true, otpId: record.id, metadata: record.metadata as Record<string, unknown> | null }
        : null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (result && typeof result === 'object' && 'verified' in result) {
      return { valid: true, metadata: result.metadata ?? undefined, otpId: result.otpId };
    }
    return { valid: false };
  }

  async invalidatePhoneOtps(phone: string, type: OtpType): Promise<void> {
    await this.prisma.otpCode.updateMany({
      where: { phone, type, isUsed: false },
      data: { isUsed: true },
    });
    const cooldownKey = OTP_COOLDOWN(phone, type);
    await this.redis.del(cooldownKey);
  }

  async verifyOtpWithMetadata(email: string, type: OtpType, code: string, options: { consume?: boolean } = {}): Promise<{ valid: boolean; metadata?: Record<string, unknown>; otpId?: string }> {
    const now = new Date();
    const consume = options.consume !== false;

    const result = await this.prisma.$transaction(async (tx) => {
      const record = await tx.otpCode.findFirst({
        where: { email, type, isUsed: false, expiresAt: { gt: now }, attempts: { lt: OTP_MAX_ATTEMPTS } },
        orderBy: { createdAt: 'desc' },
      });

      if (!record) {
        await bcrypt.compare('dummy_constant_time_sentinel', DUMMY_OTP_HASH);
        return null;
      }

      const bump = await tx.otpCode.updateMany({
        where: { id: record.id, isUsed: false, expiresAt: { gt: now }, attempts: { lt: OTP_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      if (bump.count === 0) return null;

      const isValid = await verifyOtp(code, record.code);
      if (!isValid) return null;

      if (!consume) {
        return { verified: true, otpId: record.id, email: record.email, type: record.type, metadata: record.metadata as Record<string, unknown> | null };
      }
      const used = await tx.otpCode.updateMany({
        where: { id: record.id, isUsed: false },
        data: { isUsed: true, usedAt: new Date() },
      });
      if (used.count === 1) {
        return { verified: true, otpId: record.id, email: record.email, type: record.type, metadata: record.metadata as Record<string, unknown> | null };
      }
      return null;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (result && typeof result === 'object' && 'verified' in result) {
      return { valid: true, metadata: result.metadata ?? undefined, otpId: result.otpId };
    }

    return { valid: false };
  }

  async consumeVerifiedOtp(otpId: string): Promise<boolean> {
    const consumed = await this.prisma.otpCode.updateMany({
      where: { id: otpId, isUsed: false },
      data: { isUsed: true, usedAt: new Date() },
    });
    return consumed.count === 1;
  }

  async verifyOtp(email: string, type: OtpType, code: string): Promise<boolean> {
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const record = await tx.otpCode.findFirst({
        where: { email, type, isUsed: false, expiresAt: { gt: now }, attempts: { lt: OTP_MAX_ATTEMPTS } },
        orderBy: { createdAt: 'desc' },
      });

      if (!record) {
        await bcrypt.compare('dummy_constant_time_sentinel', DUMMY_OTP_HASH);
        return false;
      }

      const bump = await tx.otpCode.updateMany({
        where: { id: record.id, isUsed: false, expiresAt: { gt: now }, attempts: { lt: OTP_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      if (bump.count === 0) return false;

      const isValid = await verifyOtp(code, record.code);
      if (!isValid) return false;

      const used = await tx.otpCode.updateMany({
        where: { id: record.id, isUsed: false },
        data: { isUsed: true, usedAt: new Date() },
      });
      if (used.count === 1) {
        return { verified: true, email: record.email, type: record.type };
      }
      return false;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    return !!result;
  }

  async invalidateOtps(email: string, type: OtpType): Promise<void> {
    await this.prisma.otpCode.updateMany({
      where: { email, type, isUsed: false },
      data: { isUsed: true },
    });
    const cooldownKey = OTP_COOLDOWN(email, type);
    await this.redis.del(cooldownKey);
  }

  async getLatestOtp(email: string, type: OtpType): Promise<{ id: string; email: string | null; code: string; type: OtpType; isUsed: boolean; attempts: number; expiresAt: Date; createdAt: Date; metadata: unknown } | null> {
    return this.prisma.otpCode.findFirst({
      where: { email, type, isUsed: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
