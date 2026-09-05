import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { WalletService } from '../wallet/wallet.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { WEBHOOK_PROCESSING, WEBHOOK_PROCESSED } from '../../common/constants/redis-keys';
import { MidtransNotificationDto } from './dto/midtrans-notification.dto';
import { OrderQrisPaymentService } from './order-qris-payment.service';
import { getWebhookRetryAt, MAX_WEBHOOK_ATTEMPTS } from './webhook-retry.constants';
import * as ErrorCodes from '../../common/constants/error-codes';

export interface WebhookResult {
  message: string;
}

const WEBHOOK_PROCESSING_TTL_SECONDS = 5 * 60; // 5 min: allows retry after transient failure
const WEBHOOK_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // Redis acceleration cache only; DB inbox is durable.

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private configService: ConfigService,
    private walletService: WalletService,
    private orderQrisPaymentService: OrderQrisPaymentService,
    private prismaService: PrismaService,
    private redisService: RedisService,
  ) {}

  async handleMidtransWebhook(
    notification: MidtransNotificationDto,
    sourceIp: string,
  ): Promise<WebhookResult> {
    if (!this.isValidMidtransSourceIp(sourceIp)) {
      this.logger.warn(`Midtrans webhook rejected: unauthorized source IP ${sourceIp}`);
      throw new ForbiddenException({
        code: ErrorCodes.WEBHOOK_UNAUTHORIZED_IP,
        message: 'Unauthorized webhook source',
      });
    }

    const order_id = notification.order_id;
    const status_code = notification.status_code;
    const gross_amount = notification.gross_amount;
    const signature_key = notification.signature_key;
    const transaction_status = notification.transaction_status;
    const transaction_id = notification.transaction_id;

    if (!order_id || !status_code || !gross_amount || !signature_key) {
      throw new BadRequestException({
        code: 'WEBHOOK_MISSING_FIELDS',
        message: 'Required webhook fields missing',
      });
    }

    const VALID_MIDTRANS_STATUSES = [
      'pending',
      'capture',
      'settlement',
      'deny',
      'authorize',
      'expire',
      'cancel',
      'refund',
      'partial_refund',
      'chargeback',
      'partial_chargeback',
      'failure',
    ] as const;
    if (
      !transaction_status ||
      !VALID_MIDTRANS_STATUSES.includes(
        transaction_status as (typeof VALID_MIDTRANS_STATUSES)[number],
      )
    ) {
      this.logger.warn(
        `Midtrans webhook unknown transaction_status="${transaction_status}" for order=${order_id}`,
      );
      throw new BadRequestException({
        code: 'WEBHOOK_INVALID_STATUS',
        message: 'Invalid transaction status',
      });
    }

    if (!this.verifyMidtransSignature(order_id, status_code, gross_amount, signature_key)) {
      this.logger.warn(`Midtrans webhook signature mismatch for order: ${order_id}`);
      throw new ForbiddenException({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Invalid webhook signature',
      });
    }

    if (!transaction_id) {
      this.logger.warn(`Midtrans webhook missing transaction_id for order=${order_id}`);
      throw new BadRequestException({
        code: 'WEBHOOK_MISSING_FIELDS',
        message: 'Required webhook field transaction_id missing',
      });
    }

    const requiresRefundKey =
      transaction_status === 'refund' || transaction_status === 'partial_refund';
    const isPartialReversal =
      transaction_status === 'partial_refund' || transaction_status === 'partial_chargeback';
    const refundReference = requiresRefundKey ? notification.refund_key?.trim() : undefined;
    if (requiresRefundKey && !refundReference) {
      // A transaction can receive multiple partial refunds. Without the merchant
      // refund key, an event cannot be made durably idempotent, so fail closed and
      // let the provider retry rather than risking an over-debit.
      throw new BadRequestException({
        code: 'WEBHOOK_REFUND_REFERENCE_REQUIRED',
        message: 'refund_key is required for refund notifications',
      });
    }
    if (isPartialReversal && !notification.refund_amount) {
      // A partial provider reversal cannot be safely debited as the full top-up.
      // Reject so Midtrans retries with the amount rather than risking an over-debit.
      throw new BadRequestException({
        code: 'WEBHOOK_REVERSAL_AMOUNT_REQUIRED',
        message: 'refund_amount is required for partial reversal notifications',
      });
    }
    const eventDiscriminator = refundReference
      ? `${transaction_status}:${refundReference}`
      : isPartialReversal
        ? `${transaction_status}:${notification.refund_amount}`
        : transaction_status;
    const processedKey = WEBHOOK_PROCESSED(transaction_id, eventDiscriminator);
    const processingKey = WEBHOOK_PROCESSING(transaction_id, eventDiscriminator);
    const processingToken = randomUUID();
    const eventKey = `MIDTRANS:${transaction_id}:${eventDiscriminator}`;

    // PostgreSQL is the source of truth. Redis only coordinates concurrent workers
    // and accelerates completed replays; Redis TTL must never be the only record of
    // a financial webhook.
    const webhookLog = await this.prismaService.webhookLog.upsert({
      where: { eventKey },
      create: {
        source: 'MIDTRANS',
        event: transaction_status,
        payload: notification as object,
        transactionId: transaction_id,
        eventKey,
        isProcessed: false,
        ipAddress: sourceIp,
        lastAttemptAt: new Date(),
      },
      update: {
        // Retry count is incremented only when processing actually fails below.
        // Provider duplicates must not consume the dead-letter budget or clear
        // retry metadata before the event is claimed for processing.
        ipAddress: sourceIp,
        lastAttemptAt: new Date(),
      },
    });

    if (webhookLog.isProcessed) {
      this.logger.warn(
        `Midtrans webhook duplicate — durable inbox already processed: txn=${transaction_id}`,
      );
      return { message: 'OK' };
    }

    // Never turn an unknown provider order into a silently successful financial event.
    // Keep the durable inbox row for operations review, but do not call wallet settlement.
    const paymentTransaction = await this.prismaService.paymentTransaction.findFirst({
      where: { midtransOrderId: order_id },
      select: { id: true, userId: true, orderId: true, status: true, purpose: true },
    });
    if (!paymentTransaction) {
      await this.prismaService.webhookLog.update({
        where: { id: webhookLog.id },
        data: {
          isProcessed: true,
          processedAt: new Date(),
          errorMessage: 'UNKNOWN_PAYMENT_TRANSACTION: manual review required',
        },
      });
      this.logger.error(
        `Midtrans webhook quarantined: no payment transaction for order=${order_id}`,
      );
      return { message: 'OK' };
    }

    if (paymentTransaction.purpose !== 'TOPUP' && paymentTransaction.purpose !== 'ORDER_ESCROW') {
      await this.prismaService.webhookLog.update({
        where: { id: webhookLog.id },
        data: {
          isProcessed: true,
          processedAt: new Date(),
          errorMessage: `UNKNOWN_PAYMENT_PURPOSE: ${String(paymentTransaction.purpose)}; manual review required`,
        },
      });
      this.logger.error(
        `Midtrans webhook quarantined: unsupported payment purpose for order=${order_id}`,
      );
      return { message: 'OK' };
    }

    if (webhookLog.deadLetteredAt) {
      this.logger.error(
        `Midtrans webhook is dead-lettered and requires manual review: txn=${transaction_id}`,
      );
      throw new ServiceUnavailableException({
        code: 'WEBHOOK_DEAD_LETTERED',
        message: 'Webhook requires manual review before retry.',
      });
    }

    // Intentional fail-closed: if Redis cannot provide a concurrency lock, return
    // 503 so Midtrans retries instead of allowing two financial workers to race.
    const claimedProcessing = await this.redisService.setNx(
      processingKey,
      processingToken,
      WEBHOOK_PROCESSING_TTL_SECONDS,
    );

    if (!claimedProcessing) {
      this.logger.warn(
        `Midtrans webhook concurrent delivery — returning 503 for retry: txn=${transaction_id}`,
      );
      throw new ServiceUnavailableException({
        code: 'WEBHOOK_CONCURRENT',
        message: 'Webhook is being processed by another handler. Retry later.',
      });
    }

    this.logger.log(
      `Midtrans webhook received: order=${order_id} txn=${transaction_id} status=${transaction_status}`,
    );

    // Terminal failure statuses all resolve the payment as failed.
    const TERMINAL_FAILURE_STATUSES = [
      'deny',
      'expire',
      'cancel',
      'failure',
      'refund',
      'partial_refund',
      'chargeback',
      'partial_chargeback',
    ] as const;

    try {
      if (transaction_status === 'settlement') {
        if (paymentTransaction.purpose === 'ORDER_ESCROW') {
          await this.orderQrisPaymentService.handleSettlement(order_id, gross_amount);
          this.logger.log(`QRIS escrow locked for order payment: ${order_id}`);
        } else {
          await this.walletService.handleTopupSuccess(order_id, gross_amount);
          this.logger.log(`Topup credited for order: ${order_id}`);
        }
      } else if (transaction_status === 'capture') {
        const fraudStatus = notification.fraud_status;
        if (fraudStatus === 'accept') {
          if (paymentTransaction.purpose === 'ORDER_ESCROW') {
            await this.orderQrisPaymentService.handleSettlement(order_id, gross_amount);
            this.logger.log(`QRIS escrow locked (capture+accept) for order payment: ${order_id}`);
          } else {
            await this.walletService.handleTopupSuccess(order_id, gross_amount);
            this.logger.log(`Topup credited (capture+accept) for order: ${order_id}`);
          }
        } else if (fraudStatus === 'deny') {
          if (paymentTransaction.purpose === 'ORDER_ESCROW') {
            await this.orderQrisPaymentService.handleFailure(order_id, 'DENY');
            this.logger.log(`QRIS order payment denied (capture+deny): ${order_id}`);
          } else {
            await this.walletService.handleTopupFailure(order_id, 'DENY');
            this.logger.log(`Topup denied (capture+deny) for order: ${order_id}`);
          }
        } else if (fraudStatus === 'challenge') {
          this.logger.error(
            `SECURITY: Capture with fraud_status=challenge for order: ${order_id} — funds NOT credited, flagging for admin review`,
          );
          // Persist fraudStatus on the PaymentTransaction so the escalation cron can find it.
          // status remains PENDING (not credited); fraudStatus='challenge' is the review signal.
          await this.prismaService.paymentTransaction.updateMany({
            where: { midtransOrderId: order_id, status: 'PENDING' },
            data: { fraudStatus: 'challenge', webhookReceivedAt: new Date() },
          });
          await this.prismaService.webhookLog.update({
            where: { id: webhookLog.id },
            data: {
              isProcessed: true,
              processedAt: new Date(),
              errorMessage: 'FRAUD_CHALLENGE: requires manual review — funds held',
            },
          });
          await this.redisService
            .setex(processedKey, WEBHOOK_IDEMPOTENCY_TTL_SECONDS, new Date().toISOString(), {
              throwOnError: true,
            })
            .catch((e: unknown) =>
              this.logger.warn(`Redis processed cache failed: ${(e as Error).message}`),
            );
          await this.redisService
            .releaseLock(processingKey, processingToken)
            .catch((e: unknown) =>
              this.logger.warn(`Redis release processingKey failed: ${(e as Error).message}`),
            );
          return { message: 'OK' };
        } else {
          this.logger.error(
            `SECURITY: Capture with unknown fraud_status="${fraudStatus}" for order: ${order_id} — flagging for manual review`,
          );
          await this.prismaService.paymentTransaction.updateMany({
            where: { midtransOrderId: order_id, status: 'PENDING' },
            data: {
              fraudStatus: `unknown:${String(fraudStatus).slice(0, 32)}`,
              webhookReceivedAt: new Date(),
            },
          });
          await this.prismaService.webhookLog.update({
            where: { id: webhookLog.id },
            data: {
              isProcessed: true,
              processedAt: new Date(),
              errorMessage: `UNKNOWN_FRAUD_STATUS: fraud_status="${fraudStatus}" requires manual review`,
            },
          });
          await this.redisService
            .setex(processedKey, WEBHOOK_IDEMPOTENCY_TTL_SECONDS, new Date().toISOString(), {
              throwOnError: true,
            })
            .catch((e: unknown) =>
              this.logger.warn(`Redis processed cache failed: ${(e as Error).message}`),
            );
          await this.redisService
            .releaseLock(processingKey, processingToken)
            .catch((e: unknown) =>
              this.logger.warn(`Redis release processingKey failed: ${(e as Error).message}`),
            );
          return { message: 'OK' };
        }
      } else if (
        transaction_status &&
        (TERMINAL_FAILURE_STATUSES as readonly string[]).includes(transaction_status)
      ) {
        if (paymentTransaction.purpose === 'ORDER_ESCROW') {
          if (transaction_status === 'refund' || transaction_status === 'chargeback') {
            await this.orderQrisPaymentService.handleRefund(
              order_id,
              refundReference ?? transaction_status,
            );
          } else if (
            transaction_status === 'partial_refund' ||
            transaction_status === 'partial_chargeback'
          ) {
            throw new ServiceUnavailableException({
              code: 'ORDER_QRIS_PARTIAL_REVERSAL_REQUIRES_REVIEW',
              message:
                'Partial QRIS reversal requires manual review before escrow can be adjusted.',
            });
          } else {
            await this.orderQrisPaymentService.handleFailure(order_id, transaction_status);
          }
          this.logger.log(
            `QRIS order payment terminal status handled: ${order_id} (${transaction_status})`,
          );
        } else {
          await this.walletService.handleTopupFailure(
            order_id,
            transaction_status.toUpperCase(),
            requiresRefundKey || isPartialReversal
              ? { refundAmount: notification.refund_amount, refundReference }
              : undefined,
          );
          this.logger.log(
            `Topup marked FAILED for order: ${order_id} (status: ${transaction_status})`,
          );
        }
      } else {
        this.logger.log(
          `Non-terminal notification status=${transaction_status} for order: ${order_id} — marking inbox event processed`,
        );
      }
    } catch (err) {
      const attempt = webhookLog.retryCount + 1;
      const deadLettered = attempt >= MAX_WEBHOOK_ATTEMPTS;
      await this.prismaService.webhookLog
        .update({
          where: { id: webhookLog.id },
          data: {
            errorMessage: String((err as Error).message ?? err).slice(0, 4000),
            retryCount: attempt,
            lastAttemptAt: new Date(),
            nextRetryAt: deadLettered ? null : getWebhookRetryAt(attempt),
            deadLetteredAt: deadLettered ? new Date() : null,
          },
        })
        .catch(updateError =>
          this.logger.error(`Failed to persist webhook failure: ${(updateError as Error).message}`),
        );
      await this.redisService
        .releaseLock(processingKey, processingToken)
        .catch((e: unknown) =>
          this.logger.warn(`Redis release processingKey failed: ${(e as Error).message}`),
        );
      throw err;
    }

    await this.prismaService.webhookLog
      .update({
        where: { id: webhookLog.id },
        data: {
          isProcessed: true,
          processedAt: new Date(),
          lastAttemptAt: new Date(),
          nextRetryAt: null,
          deadLetteredAt: null,
          errorMessage: null,
        },
      })
      .catch(err => {
        this.logger.error(`Failed to update WebhookLog: ${(err as Error).message}`);
        throw err;
      });
    await this.redisService
      .setex(processedKey, WEBHOOK_IDEMPOTENCY_TTL_SECONDS, new Date().toISOString(), {
        throwOnError: true,
      })
      .catch((e: unknown) =>
        this.logger.warn(`Redis processed cache failed: ${(e as Error).message}`),
      );
    await this.redisService
      .releaseLock(processingKey, processingToken)
      .catch((e: unknown) =>
        this.logger.warn(`Redis release processingKey failed: ${(e as Error).message}`),
      );

    return { message: 'OK' };
  }

  /**
   * Formula: SHA-512(order_id + status_code + gross_amount + server_key)
   *
   * [CRY-018] This concatenation format is mandated by Midtrans's webhook
   * specification and cannot be changed. The lack of delimiters is mitigated
   * by Midtrans guaranteeing unique order IDs and fixed-format status codes.
   */
  verifyMidtransSignature(
    orderId: string,
    statusCode: string,
    grossAmount: string,
    incomingSignatureKey: string,
  ): boolean {
    const serverKey = this.configService.get<string>('midtrans.serverKey');
    if (!serverKey) {
      this.logger.error('MIDTRANS_SERVER_KEY is not configured — cannot verify webhook signature');
      return false;
    }

    const payload = `${orderId}${statusCode}${grossAmount}${serverKey}`;
    const expectedSignature = createHash('sha512').update(payload).digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'utf8');
    const incomingBuf = Buffer.from(incomingSignatureKey ?? '', 'utf8');
    // Pre-check buffer lengths because timingSafeEqual throws on mismatch and
    // the throw itself is observable as a timing signal. Returning early keeps
    // the comparison constant-time only over the equal-length path.
    if (expectedBuf.length !== incomingBuf.length) {
      return false;
    }

    try {
      return timingSafeEqual(expectedBuf, incomingBuf);
    } catch {
      return false;
    }
  }

  isValidMidtransSourceIp(ip: string): boolean {
    const bypassIpCheck = this.configService.get<boolean>('midtrans.bypassIpCheck') === true;
    if (bypassIpCheck) {
      const nodeEnv = (this.configService.get<string>('app.nodeEnv') || 'development')
        .trim()
        .toLowerCase();
      if (nodeEnv === 'production' || nodeEnv === 'prod' || nodeEnv === 'staging') {
        this.logger.error(
          `MIDTRANS_BYPASS_IP_CHECK=true is forbidden in ${nodeEnv} — ignoring bypass flag`,
        );
      } else {
        this.logger.warn(
          `Midtrans IP allowlist bypassed via MIDTRANS_BYPASS_IP_CHECK (source: ${ip})`,
        );
        return true;
      }
    }

    const cidrsRaw = this.configService.get<string>('midtrans.allowedCidrs') || '';
    if (!cidrsRaw) {
      this.logger.error('MIDTRANS_ALLOWED_CIDRS is not configured — rejecting webhook');
      return false;
    }

    let normalizedIp = ip;
    const ipv4MappedMatch = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (ipv4MappedMatch) {
      normalizedIp = ipv4MappedMatch[1];
    }

    const isIPv6 = normalizedIp.includes(':');
    if (isIPv6) {
      const allowedList = cidrsRaw
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);
      return allowedList.some(cidr => {
        const [cidrAddr, cidrPrefix] = cidr.split('/');
        const prefixLen = parseInt(cidrPrefix ?? '128', 10);
        if (isNaN(prefixLen) || prefixLen < 0 || prefixLen > 128) return false;
        const expandedIp = this.expandIPv6(normalizedIp);
        const expandedCidr = this.expandIPv6(cidrAddr.trim());
        if (!expandedIp || !expandedCidr) return false;
        const ipBits = this.ipv6ToBits(expandedIp);
        const cidrBits = this.ipv6ToBits(expandedCidr);
        return ipBits.substring(0, prefixLen) === cidrBits.substring(0, prefixLen);
      });
    }

    const allowedCidrs = cidrsRaw
      .split(',')
      .map(c => c.trim())
      .filter(Boolean)
      .map(cidr => {
        const [networkStr, prefixStr] = cidr.split('/');
        const network = networkStr.split('.').map(Number);
        const prefixLen = parseInt(prefixStr ?? '32', 10);
        return { network, prefixLen };
      })
      // Reject CIDRs with malformed networks or out-of-range prefixes —
      // a /33 or NaN prefix would otherwise corrupt the bitmask arithmetic
      // below and silently match every IP.
      .filter(({ network, prefixLen }) => {
        if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;
        if (network.length !== 4) return false;
        return network.every(p => Number.isInteger(p) && p >= 0 && p <= 255);
      });

    const parts = normalizedIp.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false;

    return allowedCidrs.some(({ network, prefixLen }) => {
      const ipInt = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
      const netInt = (network[0] << 24) | (network[1] << 16) | (network[2] << 8) | network[3];
      const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
      return ((ipInt >>> 0) & mask) === ((netInt >>> 0) & mask);
    });
  }

  private expandIPv6(ip: string): string | null {
    try {
      let groups: string[];
      if (ip.includes('::')) {
        const [left, right] = ip.split('::');
        const leftGroups = left ? left.split(':') : [];
        const rightGroups = right ? right.split(':') : [];
        const missing = 8 - leftGroups.length - rightGroups.length;
        if (missing < 0) return null;
        groups = [...leftGroups, ...Array(missing).fill('0'), ...rightGroups];
      } else {
        groups = ip.split(':');
      }
      if (groups.length !== 8) return null;
      return groups.map(g => g.padStart(4, '0')).join(':');
    } catch {
      return null;
    }
  }

  private ipv6ToBits(expandedIp: string): string {
    return expandedIp
      .replace(/:/g, '')
      .split('')
      .map(hex => parseInt(hex, 16).toString(2).padStart(4, '0'))
      .join('');
  }
}
