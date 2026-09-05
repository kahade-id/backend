"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SanitizeBodyPipe = void 0;
const common_1 = require("@nestjs/common");
const SCRIPT_TAG_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const ORPHAN_SCRIPT_OPEN_RE = /<script\b[^>]*>/gi;
const ORPHAN_SCRIPT_CLOSE_RE = /<\/script\s*>/gi;
const EVENT_HANDLER_RE = /\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s>]*)/gi;
const JS_URI_RE = /javascript\s*:/gi;
const DATA_URI_RE = /data\s*:\s*text\/html/gi;
const BIDI_OVERRIDE_RE = /[\u202A-\u202E\u2066-\u2069]/g;
const MAX_PASSES = 5;
function stripXssPatterns(input) {
    let prev = '';
    let next = input;
    let passes = 0;
    while (prev !== next && passes < MAX_PASSES) {
        prev = next;
        next = prev
            .replace(SCRIPT_TAG_RE, '')
            .replace(ORPHAN_SCRIPT_OPEN_RE, '')
            .replace(ORPHAN_SCRIPT_CLOSE_RE, '')
            .replace(EVENT_HANDLER_RE, '')
            .replace(JS_URI_RE, '')
            .replace(DATA_URI_RE, '')
            .replace(BIDI_OVERRIDE_RE, '');
        passes += 1;
    }
    return next;
}
let SanitizeBodyPipe = class SanitizeBodyPipe {
    transform(value, metadata) {
        if (metadata.type !== 'body')
            return value;
        return this.sanitize(value);
    }
    sanitize(value) {
        if (typeof value === 'string') {
            return stripXssPatterns(value);
        }
        if (Array.isArray(value)) {
            return value.map((item) => this.sanitize(item));
        }
        if (value !== null && typeof value === 'object') {
            const sanitized = {};
            for (const [key, val] of Object.entries(value)) {
                sanitized[key] = this.sanitize(val);
            }
            return sanitized;
        }
        return value;
    }
};
exports.SanitizeBodyPipe = SanitizeBodyPipe;
exports.SanitizeBodyPipe = SanitizeBodyPipe = __decorate([
    (0, common_1.Injectable)()
], SanitizeBodyPipe);
