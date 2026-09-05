"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminSystemModule = void 0;
const common_1 = require("@nestjs/common");
const admin_system_controller_1 = require("./admin-system.controller");
const admin_system_service_1 = require("./admin-system.service");
const prisma_module_1 = require("../../../prisma/prisma.module");
const audit_log_module_1 = require("../../../common/services/audit-log.module");
const queue_module_1 = require("../../queue/queue.module");
let AdminSystemModule = class AdminSystemModule {
};
exports.AdminSystemModule = AdminSystemModule;
exports.AdminSystemModule = AdminSystemModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_1.PrismaModule, audit_log_module_1.AuditLogModule, queue_module_1.QueueModule],
        controllers: [admin_system_controller_1.AdminSystemController],
        providers: [admin_system_service_1.AdminSystemService],
    })
], AdminSystemModule);
