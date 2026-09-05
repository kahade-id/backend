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
var TemplateService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemplateService = void 0;
const common_1 = require("@nestjs/common");
const Handlebars = __importStar(require("handlebars"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
let TemplateService = TemplateService_1 = class TemplateService {
    constructor() {
        this.logger = new common_1.Logger(TemplateService_1.name);
        this.cache = new Map();
        this.templateDir = this.resolveTemplateDir();
    }
    resolveTemplateDir() {
        const distPath = path.join(__dirname, '..', '..', 'templates', 'email');
        if (fs.existsSync(distPath))
            return distPath;
        return path.join(process.cwd(), 'src', 'templates', 'email');
    }
    onModuleInit() {
        const basePath = path.join(this.templateDir, 'base.hbs');
        if (!fs.existsSync(basePath)) {
            this.logger.warn('base.hbs not found — emails will render without layout wrapper');
            this.baseTemplate = Handlebars.compile('{{{content}}}');
            return;
        }
        const baseSource = fs.readFileSync(basePath, 'utf-8');
        this.baseTemplate = Handlebars.compile(baseSource);
        this.logger.log('Email base template loaded');
    }
    render(templateName, context = {}) {
        const compiled = this.getOrCompile(templateName);
        const innerHtml = compiled(context);
        return this.baseTemplate({ ...context, content: new Handlebars.SafeString(innerHtml) });
    }
    getOrCompile(templateName) {
        const baseName = path.basename(templateName, '.hbs');
        if (!TemplateService_1.ALLOWED_TEMPLATES.has(baseName)) {
            throw new Error(`Template "${templateName}" is not in the allowlist`);
        }
        const cached = this.cache.get(baseName);
        if (cached)
            return cached;
        const filePath = path.join(this.templateDir, `${baseName}.hbs`);
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(path.resolve(this.templateDir))) {
            throw new Error(`Template path traversal attempt blocked: "${templateName}"`);
        }
        if (!fs.existsSync(filePath)) {
            throw new Error(`Email template "${baseName}" not found at ${filePath}`);
        }
        const source = fs.readFileSync(filePath, 'utf-8');
        const compiled = Handlebars.compile(source);
        this.cache.set(baseName, compiled);
        return compiled;
    }
};
exports.TemplateService = TemplateService;
TemplateService.ALLOWED_TEMPLATES = new Set([
    'email-verification', 'verify-email', 'password-reset', 'password-reset-confirm',
    'welcome', 'order-created', 'order-accepted', 'order-rejected', 'order-completed',
    'order-cancelled', 'order-shipped', 'order-payment', 'dispute-submitted',
    'dispute-decision', 'topup-success', 'withdraw-success', 'withdraw-failed',
    'withdrawal-otp', 'email-changed', 'email-changed-old', 'email-changed-notification',
    'two-fa-enabled', 'two-fa-disabled', '2fa-disable', 'subscription', 'subscription-renewed',
    'subscription-renewal-failed', 'kyc-approved', 'kyc-rejected', 'login-alert',
    'new-device-login', 'account-locked', 'account-suspended', 'admin-password-reset',
    'backup-code-used', 'data-export',
    'transfer-sent',
    'transfer-received',
]);
exports.TemplateService = TemplateService = TemplateService_1 = __decorate([
    (0, common_1.Injectable)()
], TemplateService);
