"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParseIdPipe = void 0;
const common_1 = require("@nestjs/common");
const CUID_RE = /^c[a-z0-9]{24}$/;
const PREFIXED_ID_RE = /^[A-Z]{2,5}-[A-Za-z0-9_-]{3,80}$/;
const MAX_ID_LENGTH = 100;
const KNOWN_PREFIX_PATTERNS = {
    USR: /^USR-[A-Za-z0-9_-]{8,40}$/,
    ORD: /^ORD-[A-Za-z0-9_-]{8,40}$/,
    TXN: /^TXN-[A-Za-z0-9_-]{8,40}$/,
    DSP: /^DSP-[A-Za-z0-9_-]{8,40}$/,
    WLT: /^WLT-[A-Za-z0-9_-]{8,40}$/,
    PRD: /^PRD-[A-Za-z0-9_-]{8,40}$/,
    SUB: /^SUB-[A-Za-z0-9_-]{8,40}$/,
    TKT: /^TKT-[A-Za-z0-9_-]{8,40}$/,
    ADM: /^ADM-[A-Za-z0-9_-]{8,40}$/,
};
let ParseIdPipe = class ParseIdPipe {
    transform(value) {
        if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
            throw new common_1.BadRequestException('Invalid ID format');
        }
        if (CUID_RE.test(value))
            return value;
        const dashIdx = value.indexOf('-');
        if (dashIdx > 0) {
            const prefix = value.substring(0, dashIdx);
            const pattern = KNOWN_PREFIX_PATTERNS[prefix];
            if (pattern) {
                if (pattern.test(value))
                    return value;
                throw new common_1.BadRequestException(`Invalid ${prefix} ID format`);
            }
        }
        if (PREFIXED_ID_RE.test(value))
            return value;
        throw new common_1.BadRequestException('Invalid ID format');
    }
};
exports.ParseIdPipe = ParseIdPipe;
exports.ParseIdPipe = ParseIdPipe = __decorate([
    (0, common_1.Injectable)()
], ParseIdPipe);
