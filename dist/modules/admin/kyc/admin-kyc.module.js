"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminKycModule = void 0;
const common_1 = require("@nestjs/common");
const admin_kyc_controller_1 = require("./admin-kyc.controller");
const admin_kyc_service_1 = require("./admin-kyc.service");
const audit_log_module_1 = require("../../../common/services/audit-log.module");
const upload_module_1 = require("../../upload/upload.module");
const queue_module_1 = require("../../queue/queue.module");
const redis_module_1 = require("../../../redis/redis.module");
let AdminKycModule = class AdminKycModule {
};
exports.AdminKycModule = AdminKycModule;
exports.AdminKycModule = AdminKycModule = __decorate([
    (0, common_1.Module)({
        imports: [audit_log_module_1.AuditLogModule, upload_module_1.UploadModule, queue_module_1.QueueModule, redis_module_1.RedisModule],
        controllers: [admin_kyc_controller_1.AdminKycController],
        providers: [admin_kyc_service_1.AdminKycService],
    })
], AdminKycModule);
