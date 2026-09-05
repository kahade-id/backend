"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.smtpConfig = void 0;
const config_1 = require("@nestjs/config");
exports.smtpConfig = (0, config_1.registerAs)('smtp', () => ({
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'noreply@kahade.id',
}));
