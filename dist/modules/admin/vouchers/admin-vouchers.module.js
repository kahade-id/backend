"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminVouchersModule = void 0;
const common_1 = require("@nestjs/common");
const admin_vouchers_controller_1 = require("./admin-vouchers.controller");
const admin_vouchers_service_1 = require("./admin-vouchers.service");
const audit_log_module_1 = require("../../../common/services/audit-log.module");
let AdminVouchersModule = class AdminVouchersModule {
};
exports.AdminVouchersModule = AdminVouchersModule;
exports.AdminVouchersModule = AdminVouchersModule = __decorate([
    (0, common_1.Module)({
        imports: [audit_log_module_1.AuditLogModule],
        controllers: [admin_vouchers_controller_1.AdminVouchersController],
        providers: [admin_vouchers_service_1.AdminVouchersService],
    })
], AdminVouchersModule);
