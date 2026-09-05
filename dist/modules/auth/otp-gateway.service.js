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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var OtpGatewayService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OtpGatewayService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto_1 = require("crypto");
const DEFAULT_OTP_TEMPLATE = (code, method) => `Kode verifikasi Kahade Anda: ${code}. ` +
    `Berlaku 5 menit. Jangan bagikan kode ini kepada siapa pun, termasuk staff Kahade. ` +
    `(Kanal: ${method})`;
class MockOtpProvider {
    constructor(logger) {
        this.logger = logger;
    }
    supportsMethod(_method) {
        return true;
    }
    send(phoneNumber, code, method) {
        this.logger.warn(`[MOCK OTP GATEWAY] Phone: ${phoneNumber}, Code: ${code}, Method: ${method} ` +
            `— set OTP_PROVIDER=fonnte|twilio with credentials to send real messages.`);
        return Promise.resolve({
            success: true,
            messageId: `mock_${Date.now()}_${(0, crypto_1.randomBytes)(4).toString('hex')}`,
        });
    }
}
class FonnteOtpProvider {
    constructor(logger, token, endpoint, countryCode = '62') {
        this.logger = logger;
        this.token = token;
        this.countryCode = countryCode;
        this.endpoint = endpoint || 'https://api.fonnte.com/send';
    }
    supportsMethod(method) {
        return method === 'WHATSAPP';
    }
    async send(phoneNumber, code, method) {
        if (method === 'SMS') {
            this.logger.warn(`Fonnte does not support SMS delivery — rejecting request for ${phoneNumber}. ` +
                `Configure a separate SMS provider (e.g. Twilio) or have the user select WhatsApp.`);
            return { success: false, error: 'OTP_DELIVERY_SMS_UNSUPPORTED' };
        }
        const target = this.toFonnteTarget(phoneNumber);
        const body = new URLSearchParams({
            target,
            message: DEFAULT_OTP_TEMPLATE(code, method),
            countryCode: this.countryCode,
        }).toString();
        let res;
        try {
            res = await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    Authorization: this.token,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`Fonnte network error: ${msg}`);
            return { success: false, error: 'OTP_DELIVERY_NETWORK_ERROR' };
        }
        let json = {};
        try {
            json = (await res.json());
        }
        catch {
        }
        if (!res.ok || json.status === false) {
            this.logger.error(`Fonnte send failed: status=${res.status} reason=${json.reason ?? '<no reason>'}`);
            return { success: false, error: json.reason || `OTP_DELIVERY_HTTP_${res.status}` };
        }
        const messageId = Array.isArray(json.id)
            ? String(json.id[0] ?? '')
            : json.id !== undefined
                ? String(json.id)
                : `fonnte_${Date.now()}`;
        return { success: true, messageId };
    }
    toFonnteTarget(phone) {
        return phone.replace(/^\+/, '');
    }
}
class TwilioOtpProvider {
    constructor(logger, accountSid, authToken, fromSms, fromWhatsApp) {
        this.logger = logger;
        this.accountSid = accountSid;
        this.authToken = authToken;
        this.fromSms = fromSms;
        this.fromWhatsApp = fromWhatsApp;
    }
    supportsMethod(method) {
        return method === 'WHATSAPP' ? !!this.fromWhatsApp : !!this.fromSms;
    }
    async send(phoneNumber, code, method) {
        const from = method === 'WHATSAPP' ? this.fromWhatsApp : this.fromSms;
        if (!from) {
            this.logger.error(`Twilio "from" number is not configured for method=${method}. ` +
                `Set TWILIO_SMS_FROM and/or TWILIO_WHATSAPP_FROM.`);
            return { success: false, error: 'OTP_DELIVERY_NOT_CONFIGURED' };
        }
        const to = method === 'WHATSAPP' ? `whatsapp:${phoneNumber}` : phoneNumber;
        const fromField = method === 'WHATSAPP' && !from.startsWith('whatsapp:') ? `whatsapp:${from}` : from;
        const body = new URLSearchParams({
            To: to,
            From: fromField,
            Body: DEFAULT_OTP_TEMPLATE(code, method),
        }).toString();
        const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
        const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body,
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`Twilio network error: ${msg}`);
            return { success: false, error: 'OTP_DELIVERY_NETWORK_ERROR' };
        }
        if (!res.ok) {
            let reason;
            try {
                const errJson = (await res.json());
                reason = errJson?.message;
            }
            catch {
            }
            this.logger.error(`Twilio send failed: status=${res.status} reason=${reason ?? '<no reason>'}`);
            return { success: false, error: reason || `OTP_DELIVERY_HTTP_${res.status}` };
        }
        const json = (await res.json().catch(() => ({})));
        return { success: true, messageId: json.sid ?? `twilio_${Date.now()}` };
    }
}
let OtpGatewayService = OtpGatewayService_1 = class OtpGatewayService {
    constructor(config) {
        this.config = config;
        this.logger = new common_1.Logger(OtpGatewayService_1.name);
        const configuredProvider = (this.config.get('OTP_PROVIDER') || 'mock').toLowerCase();
        const supportedProviders = ['mock', 'fonnte', 'twilio'];
        if (!supportedProviders.includes(configuredProvider) && this.isProductionRuntime()) {
            throw new Error(`Unsupported OTP_PROVIDER="${configuredProvider}" in production. Refusing to start auth gateway.`);
        }
        const providerName = (supportedProviders.includes(configuredProvider) ? configuredProvider : 'mock');
        this.providerName = providerName;
        this.provider = this.buildProvider(providerName);
        this.logger.log(`OTP gateway initialized with provider=${providerName}`);
    }
    isProductionRuntime() {
        const nodeEnv = (this.config.get('app.nodeEnv')
            ?? this.config.get('NODE_ENV')
            ?? process.env.NODE_ENV
            ?? 'development').toLowerCase();
        return ['production', 'staging'].includes(nodeEnv);
    }
    async sendOtp(phoneNumber, code, method) {
        return this.provider.send(phoneNumber, code, method);
    }
    supportsMethod(method) {
        return this.provider.supportsMethod(method);
    }
    getSupportedMethods() {
        const methods = ['SMS', 'WHATSAPP'];
        return methods.filter((m) => this.provider.supportsMethod(m));
    }
    getProviderName() {
        return this.providerName;
    }
    buildProvider(name) {
        switch (name) {
            case 'fonnte': {
                const token = this.config.get('FONNTE_API_TOKEN');
                if (!token) {
                    if (this.isProductionRuntime()) {
                        throw new Error('OTP_PROVIDER=fonnte requires FONNTE_API_TOKEN in production. Refusing to start with mock fallback.');
                    }
                    this.logger.error(`OTP_PROVIDER=fonnte but FONNTE_API_TOKEN is not set — falling back to mock gateway. ` +
                        `Real OTPs will NOT be delivered.`);
                    return new MockOtpProvider(this.logger);
                }
                return new FonnteOtpProvider(this.logger, token, this.config.get('FONNTE_API_URL') || undefined, this.config.get('FONNTE_COUNTRY_CODE') || '62');
            }
            case 'twilio': {
                const sid = this.config.get('TWILIO_ACCOUNT_SID');
                const auth = this.config.get('TWILIO_AUTH_TOKEN');
                const fromSms = this.config.get('TWILIO_SMS_FROM') || '';
                const fromWa = this.config.get('TWILIO_WHATSAPP_FROM') || '';
                if (!sid || !auth || (!fromSms && !fromWa)) {
                    if (this.isProductionRuntime()) {
                        throw new Error('OTP_PROVIDER=twilio requires account credentials and at least one sender in production. Refusing to start with mock fallback.');
                    }
                    this.logger.error(`OTP_PROVIDER=twilio is missing account credentials or a sender — ` +
                        `falling back to mock gateway. Real OTPs will NOT be delivered.`);
                    return new MockOtpProvider(this.logger);
                }
                return new TwilioOtpProvider(this.logger, sid, auth, fromSms, fromWa);
            }
            case 'mock':
                if (this.isProductionRuntime()) {
                    throw new Error('OTP_PROVIDER=mock is not allowed in production. Configure Fonnte or Twilio before starting auth.');
                }
                return new MockOtpProvider(this.logger);
            default:
                if (this.isProductionRuntime()) {
                    throw new Error(`Unsupported OTP_PROVIDER="${name}" in production. Refusing to start auth gateway.`);
                }
                return new MockOtpProvider(this.logger);
        }
    }
};
exports.OtpGatewayService = OtpGatewayService;
exports.OtpGatewayService = OtpGatewayService = OtpGatewayService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(config_1.ConfigService)),
    __metadata("design:paramtypes", [config_1.ConfigService])
], OtpGatewayService);
