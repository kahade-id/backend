"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestIdInterceptor = void 0;
const common_1 = require("@nestjs/common");
const rxjs_1 = require("rxjs");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../prisma/prisma.service");
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let RequestIdInterceptor = class RequestIdInterceptor {
    intercept(context, next) {
        const request = context.switchToHttp().getRequest();
        const response = context.switchToHttp().getResponse();
        const rawId = request.headers['x-request-id'];
        const requestId = typeof rawId === 'string' && UUID_V4_RE.test(rawId)
            ? rawId
            : (0, crypto_1.randomUUID)();
        request.requestId = requestId;
        response.setHeader('X-Request-ID', requestId);
        return new rxjs_1.Observable((subscriber) => {
            prisma_service_1.requestContext.run({ requestId }, () => {
                next.handle().subscribe({
                    next: (val) => subscriber.next(val),
                    error: (err) => subscriber.error(err),
                    complete: () => subscriber.complete(),
                });
            });
        });
    }
};
exports.RequestIdInterceptor = RequestIdInterceptor;
exports.RequestIdInterceptor = RequestIdInterceptor = __decorate([
    (0, common_1.Injectable)()
], RequestIdInterceptor);
