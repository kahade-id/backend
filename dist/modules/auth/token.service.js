"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenService = exports.TEMP_TOKEN_AUDIENCE = exports.ADMIN_REFRESH_TOKEN_AUDIENCE = exports.REFRESH_TOKEN_AUDIENCE = exports.ADMIN_TOKEN_AUDIENCE = exports.USER_TOKEN_AUDIENCE = exports.TOKEN_ISSUER = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const config_1 = require("@nestjs/config");
const nanoid_1 = require("nanoid");
exports.TOKEN_ISSUER = 'kahade-auth';
exports.USER_TOKEN_AUDIENCE = 'kahade-api';
exports.ADMIN_TOKEN_AUDIENCE = 'kahade-admin-api';
exports.REFRESH_TOKEN_AUDIENCE = 'kahade-refresh';
exports.ADMIN_REFRESH_TOKEN_AUDIENCE = 'kahade-admin-refresh';
exports.TEMP_TOKEN_AUDIENCE = 'kahade-2fa';
let TokenService = class TokenService {
    constructor(jwtService, configService) {
        this.jwtService = jwtService;
        this.configService = configService;
    }
    signAccessToken(payload) {
        const jti = (0, nanoid_1.nanoid)();
        return this.jwtService.sign({ ...payload, jti, iss: exports.TOKEN_ISSUER, aud: exports.USER_TOKEN_AUDIENCE }, {
            secret: this.configService.get('jwt.secret'),
            expiresIn: this.configService.get('jwt.expiresIn') ?? '15m',
            algorithm: 'HS256',
        });
    }
    signAdminAccessToken(payload) {
        const jti = (0, nanoid_1.nanoid)();
        return this.jwtService.sign({ ...payload, jti, iss: exports.TOKEN_ISSUER, aud: exports.ADMIN_TOKEN_AUDIENCE }, {
            secret: this.configService.get('jwt.adminSecret'),
            expiresIn: this.configService.get('jwt.adminExpiresIn') ?? '30m',
            algorithm: 'HS256',
        });
    }
    signRefreshToken(payload) {
        const jti = (0, nanoid_1.nanoid)();
        return this.jwtService.sign({ ...payload, jti, iss: exports.TOKEN_ISSUER, aud: exports.REFRESH_TOKEN_AUDIENCE }, {
            secret: this.configService.get('jwt.refreshSecret'),
            expiresIn: this.configService.get('jwt.refreshExpiresIn') ?? '7d',
            algorithm: 'HS256',
        });
    }
    signAdminRefreshToken(payload) {
        const jti = (0, nanoid_1.nanoid)();
        return this.jwtService.sign({ ...payload, jti, iss: exports.TOKEN_ISSUER, aud: exports.ADMIN_REFRESH_TOKEN_AUDIENCE }, {
            secret: this.configService.get('jwt.adminRefreshSecret'),
            expiresIn: this.configService.get('jwt.adminRefreshExpiresIn') ?? '7d',
            algorithm: 'HS256',
        });
    }
    signTempToken(payload) {
        const jti = (0, nanoid_1.nanoid)();
        const tempSecret = this.configService.get('jwt.tempSecret');
        if (!tempSecret) {
            throw new Error('JWT_TEMP_SECRET is not configured. Cannot issue temp tokens.');
        }
        return this.jwtService.sign({ ...payload, jti, iss: exports.TOKEN_ISSUER, aud: exports.TEMP_TOKEN_AUDIENCE }, {
            secret: tempSecret,
            expiresIn: this.configService.get('jwt.tempExpiresIn') ?? '5m',
            algorithm: 'HS256',
        });
    }
    verifyAccessToken(token) {
        return this.jwtService.verify(token, {
            secret: this.configService.get('jwt.secret'),
            audience: exports.USER_TOKEN_AUDIENCE,
            issuer: exports.TOKEN_ISSUER,
            algorithms: ['HS256'],
        });
    }
    verifyAdminToken(token) {
        return this.jwtService.verify(token, {
            secret: this.configService.get('jwt.adminSecret'),
            audience: exports.ADMIN_TOKEN_AUDIENCE,
            issuer: exports.TOKEN_ISSUER,
            algorithms: ['HS256'],
        });
    }
    verifyRefreshToken(token) {
        return this.jwtService.verify(token, {
            secret: this.configService.get('jwt.refreshSecret'),
            audience: exports.REFRESH_TOKEN_AUDIENCE,
            issuer: exports.TOKEN_ISSUER,
            algorithms: ['HS256'],
        });
    }
    verifyAdminRefreshToken(token) {
        return this.jwtService.verify(token, {
            secret: this.configService.get('jwt.adminRefreshSecret'),
            audience: exports.ADMIN_REFRESH_TOKEN_AUDIENCE,
            issuer: exports.TOKEN_ISSUER,
            algorithms: ['HS256'],
        });
    }
    verifyTempToken(token) {
        const tempSecret = this.configService.get('jwt.tempSecret');
        if (!tempSecret) {
            throw new Error('JWT_TEMP_SECRET is not configured. Cannot verify temp tokens.');
        }
        return this.jwtService.verify(token, {
            secret: tempSecret,
            audience: exports.TEMP_TOKEN_AUDIENCE,
            issuer: exports.TOKEN_ISSUER,
            algorithms: ['HS256'],
        });
    }
    decodeToken(token) {
        return this.jwtService.decode(token);
    }
};
exports.TokenService = TokenService;
exports.TokenService = TokenService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [jwt_1.JwtService,
        config_1.ConfigService])
], TokenService);
