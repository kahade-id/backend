"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisputesModule = void 0;
const common_1 = require("@nestjs/common");
const prisma_module_1 = require("../../prisma/prisma.module");
const redis_module_1 = require("../../redis/redis.module");
const upload_module_1 = require("../upload/upload.module");
const orders_module_1 = require("../orders/orders.module");
const disputes_controller_1 = require("./disputes.controller");
const disputes_service_1 = require("./disputes.service");
const dispute_message_service_1 = require("./dispute-message.service");
const dispute_call_service_1 = require("./dispute-call.service");
const mutual_resolution_service_1 = require("./mutual-resolution.service");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const audit_log_module_1 = require("../../common/services/audit-log.module");
let DisputesModule = class DisputesModule {
};
exports.DisputesModule = DisputesModule;
exports.DisputesModule = DisputesModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_1.PrismaModule, redis_module_1.RedisModule, upload_module_1.UploadModule, audit_log_module_1.AuditLogModule, (0, common_1.forwardRef)(() => orders_module_1.OrdersModule)],
        controllers: [disputes_controller_1.DisputesController],
        providers: [disputes_service_1.DisputesService, dispute_message_service_1.DisputeMessageService, dispute_call_service_1.DisputeCallService, mutual_resolution_service_1.MutualResolutionService, wallet_tx_serial_service_1.WalletTxSerialService],
        exports: [disputes_service_1.DisputesService],
    })
], DisputesModule);
