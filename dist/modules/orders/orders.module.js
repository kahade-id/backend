"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrdersModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const orders_controller_1 = require("./orders.controller");
const orders_service_1 = require("./orders.service");
const fee_calculator_service_1 = require("./fee-calculator.service");
const order_state_service_1 = require("./order-state.service");
const order_extensions_service_1 = require("./order-extensions.service");
const order_links_service_1 = require("./order-links.service");
const delivery_proof_service_1 = require("./delivery-proof.service");
const invoice_service_1 = require("./invoice.service");
const receipt_service_1 = require("./receipt.service");
const membership_rank_service_1 = require("./membership-rank.service");
const wallet_module_1 = require("../wallet/wallet.module");
const redis_module_1 = require("../../redis/redis.module");
const wallet_tx_serial_service_1 = require("../../common/services/wallet-tx-serial.service");
const referral_module_1 = require("../referral/referral.module");
const disputes_module_1 = require("../disputes/disputes.module");
const realtime_module_1 = require("../realtime/realtime.module");
const upload_module_1 = require("../upload/upload.module");
const audit_log_module_1 = require("../../common/services/audit-log.module");
const queue_module_1 = require("../queue/queue.module");
const payment_module_1 = require("../payment/payment.module");
let OrdersModule = class OrdersModule {
};
exports.OrdersModule = OrdersModule;
exports.OrdersModule = OrdersModule = __decorate([
    (0, common_1.Module)({
        imports: [config_1.ConfigModule, wallet_module_1.WalletModule, redis_module_1.RedisModule, referral_module_1.ReferralModule, (0, common_1.forwardRef)(() => disputes_module_1.DisputesModule), realtime_module_1.RealtimeModule, upload_module_1.UploadModule, audit_log_module_1.AuditLogModule, queue_module_1.QueueModule, payment_module_1.PaymentModule],
        controllers: [orders_controller_1.OrdersController],
        providers: [orders_service_1.OrdersService, fee_calculator_service_1.FeeCalculatorService, order_state_service_1.OrderStateService, order_extensions_service_1.OrderExtensionsService, order_links_service_1.OrderLinksService, delivery_proof_service_1.DeliveryProofService, invoice_service_1.InvoiceService, receipt_service_1.ReceiptService, membership_rank_service_1.MembershipRankService, wallet_tx_serial_service_1.WalletTxSerialService],
        exports: [orders_service_1.OrdersService, fee_calculator_service_1.FeeCalculatorService, order_state_service_1.OrderStateService, order_extensions_service_1.OrderExtensionsService, order_links_service_1.OrderLinksService, delivery_proof_service_1.DeliveryProofService, invoice_service_1.InvoiceService, receipt_service_1.ReceiptService, membership_rank_service_1.MembershipRankService],
    })
], OrdersModule);
