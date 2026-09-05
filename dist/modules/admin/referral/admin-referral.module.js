"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminReferralModule = void 0;
const common_1 = require("@nestjs/common");
const admin_referral_controller_1 = require("./admin-referral.controller");
const admin_referral_service_1 = require("./admin-referral.service");
let AdminReferralModule = class AdminReferralModule {
};
exports.AdminReferralModule = AdminReferralModule;
exports.AdminReferralModule = AdminReferralModule = __decorate([
    (0, common_1.Module)({
        controllers: [admin_referral_controller_1.AdminReferralController],
        providers: [admin_referral_service_1.AdminReferralService],
    })
], AdminReferralModule);
