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
exports.PaginationClampInterceptor = void 0;
const common_1 = require("@nestjs/common");
let PaginationClampInterceptor = class PaginationClampInterceptor {
    constructor(maxLimit = 100) {
        this.maxLimit = maxLimit;
    }
    intercept(context, next) {
        const req = context.switchToHttp().getRequest();
        const res = context.switchToHttp().getResponse();
        const rawLimit = Number(req.query?.limit);
        if (!Number.isNaN(rawLimit) && rawLimit > this.maxLimit) {
            req.query.limit = String(this.maxLimit);
            res.setHeader('X-Pagination-Clamped', 'true');
            res.setHeader('X-Pagination-Max-Limit', String(this.maxLimit));
        }
        return next.handle();
    }
};
exports.PaginationClampInterceptor = PaginationClampInterceptor;
exports.PaginationClampInterceptor = PaginationClampInterceptor = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [Object])
], PaginationClampInterceptor);
