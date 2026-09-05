"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminDisputesModule = void 0;
const common_1 = require("@nestjs/common");
const admin_disputes_controller_1 = require("./admin-disputes.controller");
const admin_disputes_service_1 = require("./admin-disputes.service");
const wallet_tx_serial_service_1 = require("../../../common/services/wallet-tx-serial.service");
const audit_log_module_1 = require("../../../common/services/audit-log.module");
const upload_module_1 = require("../../upload/upload.module");
let AdminDisputesModule = class AdminDisputesModule {
};
exports.AdminDisputesModule = AdminDisputesModule;
exports.AdminDisputesModule = AdminDisputesModule = __decorate([
    (0, common_1.Module)({
        imports: [audit_log_module_1.AuditLogModule, upload_module_1.UploadModule],
        controllers: [admin_disputes_controller_1.AdminDisputesController],
        providers: [admin_disputes_service_1.AdminDisputesService, wallet_tx_serial_service_1.WalletTxSerialService],
        exports: [admin_disputes_service_1.AdminDisputesService],
    })
], AdminDisputesModule);
