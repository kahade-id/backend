"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fcmConfig = void 0;
const config_1 = require("@nestjs/config");
exports.fcmConfig = (0, config_1.registerAs)('fcm', () => ({
    projectId: process.env.FCM_PROJECT_ID || '',
    clientEmail: process.env.FCM_CLIENT_EMAIL || '',
    privateKey: (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
}));
