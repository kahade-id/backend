"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReadOnlySmokeModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const config_2 = require("../config");
const env_validation_1 = require("../config/env.validation");
const prisma_module_1 = require("../prisma/prisma.module");
const redis_module_1 = require("../redis/redis.module");
const health_module_1 = require("../modules/health/health.module");
const bootstrap_mode_1 = require("./bootstrap-mode");
const smokeEnvFile = (0, bootstrap_mode_1.getSmokeEnvFile)();
let ReadOnlySmokeModule = class ReadOnlySmokeModule {
};
exports.ReadOnlySmokeModule = ReadOnlySmokeModule;
exports.ReadOnlySmokeModule = ReadOnlySmokeModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                envFilePath: smokeEnvFile,
                load: [config_2.appConfig, config_2.databaseConfig, config_2.jwtConfig, config_2.cryptoConfig, config_2.redisConfig, config_2.midtransConfig, config_2.r2Config, config_2.smtpConfig, config_2.fcmConfig],
                validate: env_validation_1.validateEnv,
            }),
            prisma_module_1.PrismaModule,
            redis_module_1.RedisModule,
            health_module_1.HealthModule,
        ],
    })
], ReadOnlySmokeModule);
