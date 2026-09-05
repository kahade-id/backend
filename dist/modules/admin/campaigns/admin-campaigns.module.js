"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminCampaignsModule = void 0;
const common_1 = require("@nestjs/common");
const admin_campaigns_controller_1 = require("./admin-campaigns.controller");
const campaign_service_1 = require("../campaign.service");
const audit_log_module_1 = require("../../../common/services/audit-log.module");
let AdminCampaignsModule = class AdminCampaignsModule {
};
exports.AdminCampaignsModule = AdminCampaignsModule;
exports.AdminCampaignsModule = AdminCampaignsModule = __decorate([
    (0, common_1.Module)({
        imports: [audit_log_module_1.AuditLogModule],
        controllers: [admin_campaigns_controller_1.AdminCampaignsController],
        providers: [campaign_service_1.CampaignService],
    })
], AdminCampaignsModule);
