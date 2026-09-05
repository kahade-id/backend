"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupportModule = void 0;
const common_1 = require("@nestjs/common");
const support_controller_1 = require("./support.controller");
const support_service_1 = require("./support.service");
const prisma_module_1 = require("../../prisma/prisma.module");
const upload_module_1 = require("../upload/upload.module");
const audit_log_module_1 = require("../../common/services/audit-log.module");
let SupportModule = class SupportModule {
};
exports.SupportModule = SupportModule;
exports.SupportModule = SupportModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_1.PrismaModule, upload_module_1.UploadModule, audit_log_module_1.AuditLogModule],
        controllers: [support_controller_1.SupportController],
        providers: [support_service_1.SupportService],
    })
], SupportModule);
