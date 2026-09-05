"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthModule = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const auth_controller_1 = require("./auth.controller");
const auth_service_1 = require("./auth.service");
const token_service_1 = require("./token.service");
const otp_service_1 = require("./otp.service");
const captcha_service_1 = require("./captcha.service");
const otp_gateway_service_1 = require("./otp-gateway.service");
const queue_module_1 = require("../queue/queue.module");
const audit_log_module_1 = require("../../common/services/audit-log.module");
let AuthModule = class AuthModule {
};
exports.AuthModule = AuthModule;
exports.AuthModule = AuthModule = __decorate([
    (0, common_1.Global)(),
    (0, common_1.Module)({
        imports: [
            jwt_1.JwtModule.register({}),
            queue_module_1.QueueModule,
            audit_log_module_1.AuditLogModule,
        ],
        controllers: [auth_controller_1.AuthController],
        providers: [auth_service_1.AuthService, token_service_1.TokenService, otp_service_1.OtpService, captcha_service_1.CaptchaService, otp_gateway_service_1.OtpGatewayService],
        exports: [auth_service_1.AuthService, token_service_1.TokenService, otp_service_1.OtpService, captcha_service_1.CaptchaService, otp_gateway_service_1.OtpGatewayService, jwt_1.JwtModule],
    })
], AuthModule);
