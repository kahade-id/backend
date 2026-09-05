"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var WalletTxSerialService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletTxSerialService = void 0;
const common_1 = require("@nestjs/common");
const redis_service_1 = require("../../redis/redis.service");
const prisma_service_1 = require("../../prisma/prisma.service");
const date_util_1 = require("../utils/date.util");
let WalletTxSerialService = WalletTxSerialService_1 = class WalletTxSerialService {
    constructor(redis, prisma) {
        this.redis = redis;
        this.prisma = prisma;
        this.logger = new common_1.Logger(WalletTxSerialService_1.name);
    }
    async getNext() {
        return this.getNextForPrefix('wallet_tx_serial');
    }
    async atomicIncr(key) {
        const client = this.redis.getClient();
        const prefixedKey = this.redis.getPrefix() + key;
        const result = await client.eval(WalletTxSerialService_1.LUA_ATOMIC_INCR, 1, prefixedKey, WalletTxSerialService_1.TTL_2_DAYS);
        return result;
    }
    async getNextForPrefix(prefix) {
        const today = (0, date_util_1.formatWIBDate)().replace(/-/g, '');
        const key = `${prefix}:${today}`;
        const lockKey = `${key}:sync_lock`;
        const serial = await this.atomicIncr(key);
        if (serial === 1) {
            const acquired = await this.redis.setNx(lockKey, '1', 30);
            if (acquired) {
                try {
                    const existingSerial = await this.syncFromDb(prefix, today);
                    if (existingSerial > 0) {
                        const newSerial = existingSerial + 1;
                        const client = this.redis.getClient();
                        const prefixedKey = this.redis.getPrefix() + key;
                        const result = await client.eval(WalletTxSerialService_1.LUA_SET_IF_GREATER, 1, prefixedKey, String(newSerial), WalletTxSerialService_1.TTL_2_DAYS);
                        return result;
                    }
                }
                finally {
                    await this.redis.del(lockKey);
                }
            }
            else {
                await new Promise(resolve => setTimeout(resolve, 100));
                const current = await this.redis.get(key);
                if (current) {
                    const val = parseInt(current, 10);
                    if (!isNaN(val) && val > serial) {
                        return await this.atomicIncr(key);
                    }
                }
            }
        }
        return serial;
    }
    async syncFromDb(prefix, today) {
        try {
            const prefixMap = {
                wallet_tx_serial: { model: 'walletTransaction', field: 'txId', txPrefix: `WLT-${today}-` },
                dispute_serial: { model: 'dispute', field: 'disputeId', txPrefix: `DSP-${today}-` },
                payment_serial: { model: 'walletTransaction', field: 'txId', txPrefix: `PAY-${today}-` },
            };
            const config = prefixMap[prefix];
            if (!config)
                return 0;
            if (config.model === 'walletTransaction') {
                const maxTx = await this.prisma.walletTransaction.findFirst({
                    where: { txId: { startsWith: config.txPrefix } },
                    orderBy: { txId: 'desc' },
                    select: { txId: true },
                });
                if (maxTx) {
                    const parts = maxTx.txId.split('-');
                    const existing = parseInt(parts[parts.length - 1], 10);
                    if (!isNaN(existing) && existing >= 1) {
                        this.logger.warn(`DB sync for ${prefix}: recovered serial ${existing} from ${maxTx.txId}`);
                        return existing;
                    }
                }
            }
            else if (config.model === 'dispute') {
                const maxDispute = await this.prisma.dispute.findFirst({
                    where: { disputeId: { startsWith: config.txPrefix } },
                    orderBy: { disputeId: 'desc' },
                    select: { disputeId: true },
                });
                if (maxDispute) {
                    const parts = maxDispute.disputeId.split('-');
                    const existing = parseInt(parts[parts.length - 1], 10);
                    if (!isNaN(existing) && existing >= 1) {
                        this.logger.warn(`DB sync for ${prefix}: recovered serial ${existing} from ${maxDispute.disputeId}`);
                        return existing;
                    }
                }
            }
        }
        catch (err) {
            this.logger.error(`DB sync failed for ${prefix}: ${err.message}`);
        }
        return 0;
    }
};
exports.WalletTxSerialService = WalletTxSerialService;
WalletTxSerialService.TTL_2_DAYS = 86400 * 2;
WalletTxSerialService.LUA_ATOMIC_INCR = `
    local key = KEYS[1]
    local ttl = tonumber(ARGV[1])
    local current = redis.call('INCR', key)
    if current == 1 then
      redis.call('EXPIRE', key, ttl)
    end
    return current
  `;
WalletTxSerialService.LUA_SET_IF_GREATER = `
    local key = KEYS[1]
    local newVal = tonumber(ARGV[1])
    local ttl = tonumber(ARGV[2])
    local current = tonumber(redis.call('GET', key) or '0')
    if newVal > current then
      redis.call('SET', key, ARGV[1], 'EX', ttl)
      return newVal
    end
    return current
  `;
exports.WalletTxSerialService = WalletTxSerialService = WalletTxSerialService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService,
        prisma_service_1.PrismaService])
], WalletTxSerialService);
