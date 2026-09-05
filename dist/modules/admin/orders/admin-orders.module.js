"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminOrdersModule = void 0;
const common_1 = require("@nestjs/common");
const admin_orders_controller_1 = require("./admin-orders.controller");
const admin_orders_service_1 = require("./admin-orders.service");
const audit_log_module_1 = require("../../../common/services/audit-log.module");
const orders_module_1 = require("../../orders/orders.module");
const wallet_module_1 = require("../../wallet/wallet.module");
const referral_module_1 = require("../../referral/referral.module");
let AdminOrdersModule = class AdminOrdersModule {
};
exports.AdminOrdersModule = AdminOrdersModule;
exports.AdminOrdersModule = AdminOrdersModule = __decorate([
    (0, common_1.Module)({
        imports: [audit_log_module_1.AuditLogModule, orders_module_1.OrdersModule, wallet_module_1.WalletModule, referral_module_1.ReferralModule],
        controllers: [admin_orders_controller_1.AdminOrdersController],
        providers: [admin_orders_service_1.AdminOrdersService],
    })
], AdminOrdersModule);
