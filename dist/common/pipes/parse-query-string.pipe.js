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
exports.ParsePagePipe = exports.ParseDateQueryPipe = exports.ParseEnumQueryPipe = exports.ParseQueryStringPipe = void 0;
const common_1 = require("@nestjs/common");
let ParseQueryStringPipe = class ParseQueryStringPipe {
    constructor(paramName, maxLength = 200) {
        this.paramName = paramName;
        this.maxLength = maxLength;
    }
    transform(value) {
        if (value === undefined || value === null)
            return value;
        if (typeof value !== 'string') {
            throw new common_1.BadRequestException(`${this.paramName} must be a string`);
        }
        if (value.length > this.maxLength) {
            throw new common_1.BadRequestException(`${this.paramName} exceeds maximum length of ${this.maxLength}`);
        }
        return value.replace(/[<>&"']/g, '');
    }
};
exports.ParseQueryStringPipe = ParseQueryStringPipe;
exports.ParseQueryStringPipe = ParseQueryStringPipe = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [String, Object])
], ParseQueryStringPipe);
let ParseEnumQueryPipe = class ParseEnumQueryPipe {
    constructor(paramName, allowedValues) {
        this.paramName = paramName;
        this.allowed = new Set(allowedValues);
    }
    transform(value) {
        if (value === undefined || value === null)
            return value;
        if (typeof value !== 'string' || !this.allowed.has(value)) {
            throw new common_1.BadRequestException(`${this.paramName} must be one of: ${[...this.allowed].join(', ')}`);
        }
        return value;
    }
};
exports.ParseEnumQueryPipe = ParseEnumQueryPipe;
exports.ParseEnumQueryPipe = ParseEnumQueryPipe = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [String, Array])
], ParseEnumQueryPipe);
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
let ParseDateQueryPipe = class ParseDateQueryPipe {
    constructor(paramName) {
        this.paramName = paramName;
    }
    transform(value) {
        if (value === undefined || value === null)
            return value;
        if (typeof value !== 'string' || value.length > 30) {
            throw new common_1.BadRequestException(`${this.paramName} must be a valid ISO 8601 date string`);
        }
        if (!ISO_8601_PATTERN.test(value)) {
            throw new common_1.BadRequestException(`${this.paramName} must be a valid ISO 8601 date (e.g. 2024-01-15 or 2024-01-15T10:30:00Z)`);
        }
        const d = new Date(value);
        if (isNaN(d.getTime())) {
            throw new common_1.BadRequestException(`${this.paramName} must be a valid date`);
        }
        return value;
    }
};
exports.ParseDateQueryPipe = ParseDateQueryPipe;
exports.ParseDateQueryPipe = ParseDateQueryPipe = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [String])
], ParseDateQueryPipe);
let ParsePagePipe = class ParsePagePipe {
    transform(value) {
        return Math.max(1, value);
    }
};
exports.ParsePagePipe = ParsePagePipe;
exports.ParsePagePipe = ParsePagePipe = __decorate([
    (0, common_1.Injectable)()
], ParsePagePipe);
