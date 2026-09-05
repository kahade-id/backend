"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WalletModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const bull_1 = require("@nestjs/bull");
const wallet_controller_1 = require("./wallet.controller");
const wallet_service_1 = require("./wallet.service");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const midtrans_service_1 = require("../payment/midtrans.service");
const otp_service_1 = require("../auth/otp.service");
const export_service_1 = require("./export.service");
const redis_module_1 = require("../../redis/redis.module");
const audit_log_module_1 = require("../../common/services/audit-log.module");
const email_processor_1 = require("../queue/processors/email.processor");
let WalletModule = class WalletModule {
};
exports.WalletModule = WalletModule;
exports.WalletModule = WalletModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule,
            redis_module_1.RedisModule,
            audit_log_module_1.AuditLogModule,
            bull_1.BullModule.registerQueue({
                name: email_processor_1.EMAIL_QUEUE,
                settings: { stalledInterval: 30_000, maxStalledCount: 1 },
                defaultJobOptions: {
                    attempts: 3,
                    timeout: 120_000,
                    backoff: { type: 'exponential', delay: 5_000 },
                    removeOnComplete: 100,
                    removeOnFail: 50,
                },
            }),
        ],
        controllers: [wallet_controller_1.WalletController],
        providers: [wallet_service_1.WalletService, wallet_tx_serial_service_1.WalletTxSerialService, midtrans_service_1.MidtransService, otp_service_1.OtpService, export_service_1.WalletExportService],
        exports: [wallet_service_1.WalletService, wallet_tx_serial_service_1.WalletTxSerialService, export_service_1.WalletExportService],
    })
], WalletModule);
