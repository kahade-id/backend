"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminFinanceModule = void 0;
const common_1 = require("@nestjs/common");
const bull_1 = require("@nestjs/bull");
const admin_finance_controller_1 = require("./admin-finance.controller");
const admin_finance_service_1 = require("./admin-finance.service");
const reconciliation_service_1 = require("./reconciliation.service");
const reconciliation_processor_1 = require("./reconciliation.processor");
const prisma_module_1 = require("../../../prisma/prisma.module");
const audit_log_module_1 = require("../../../common/services/audit-log.module");
const payment_module_1 = require("../../../modules/payment/payment.module");
let AdminFinanceModule = class AdminFinanceModule {
};
exports.AdminFinanceModule = AdminFinanceModule;
exports.AdminFinanceModule = AdminFinanceModule = __decorate([
    (0, common_1.Module)({
        imports: [
            prisma_module_1.PrismaModule,
            audit_log_module_1.AuditLogModule,
            payment_module_1.PaymentModule,
            bull_1.BullModule.registerQueue({
                name: reconciliation_processor_1.RECONCILIATION_QUEUE,
                defaultJobOptions: {
                    attempts: 1,
                    removeOnComplete: 20,
                    removeOnFail: 10,
                },
            }),
        ],
        controllers: [admin_finance_controller_1.AdminFinanceController],
        providers: [admin_finance_service_1.AdminFinanceService, reconciliation_service_1.ReconciliationService, reconciliation_processor_1.ReconciliationProcessor],
        exports: [reconciliation_service_1.ReconciliationService],
    })
], AdminFinanceModule);
