"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CaptchaService = void 0;
const common_1 = require("@nestjs/common");
const redis_service_1 = require("../../redis/redis.service");
const crypto = __importStar(require("crypto"));
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const CAPTCHA_PREFIX = 'captcha:';
const CAPTCHA_TTL = 120;
const CAPTCHA_MIN_SOLVE_MS = 800;
const CAPTCHA_MAX_SOLVE_MS = 120_000;
const POSITION_TOLERANCE = 4;
const TARGET_X_MIN = 20;
const TARGET_X_RANGE = 60;
let CaptchaService = class CaptchaService {
    constructor(redis) {
        this.redis = redis;
    }
    async generateChallenge() {
        const challengeId = crypto.randomUUID();
        const targetX = TARGET_X_MIN + crypto.randomInt(0, TARGET_X_RANGE);
        const issuedAt = Date.now();
        await this.redis.set(`${CAPTCHA_PREFIX}${challengeId}`, JSON.stringify({ targetX, issuedAt }), CAPTCHA_TTL, { throwOnError: true });
        return { challengeId, targetX };
    }
    async verifyChallenge(challengeId, answerX) {
        if (!challengeId || typeof answerX !== 'number') {
            throw new common_1.BadRequestException({ code: ErrorCodes.CAPTCHA_FAILED, message: 'Invalid captcha response' });
        }
        const key = `${CAPTCHA_PREFIX}${challengeId}`;
        const raw = await this.redis.get(key, { throwOnError: true });
        if (!raw) {
            throw new common_1.BadRequestException({ code: ErrorCodes.CAPTCHA_EXPIRED, message: 'Captcha expired or already used. Please try again.' });
        }
        await this.redis.del(key, { throwOnError: true });
        let data;
        try {
            data = JSON.parse(raw);
        }
        catch {
            throw new common_1.BadRequestException({ code: ErrorCodes.CAPTCHA_FAILED, message: 'Invalid captcha data' });
        }
        const elapsed = Date.now() - data.issuedAt;
        if (elapsed < CAPTCHA_MIN_SOLVE_MS) {
            throw new common_1.BadRequestException({ code: ErrorCodes.CAPTCHA_FAILED, message: 'Captcha solved too quickly' });
        }
        if (elapsed > CAPTCHA_MAX_SOLVE_MS) {
            throw new common_1.BadRequestException({ code: ErrorCodes.CAPTCHA_EXPIRED, message: 'Captcha expired. Please try again.' });
        }
        const diff = Math.abs(data.targetX - answerX);
        if (diff > POSITION_TOLERANCE) {
            throw new common_1.BadRequestException({ code: ErrorCodes.CAPTCHA_FAILED, message: 'Captcha verification failed. Please try again.' });
        }
    }
};
exports.CaptchaService = CaptchaService;
exports.CaptchaService = CaptchaService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService])
], CaptchaService);
