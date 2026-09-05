import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';

export type OtpDeliveryMethod = 'SMS' | 'WHATSAPP';
export type OtpProviderName = 'mock' | 'fonnte' | 'twilio';

export interface OtpDeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

interface OtpProviderAdapter {
  send(phoneNumber: string, code: string, method: OtpDeliveryMethod): Promise<OtpDeliveryResult>;
  supportsMethod(method: OtpDeliveryMethod): boolean;
}

const DEFAULT_OTP_TEMPLATE = (code: string, method: OtpDeliveryMethod): string =>
  `Kode verifikasi Kahade Anda: ${code}. ` +
  `Berlaku 5 menit. Jangan bagikan kode ini kepada siapa pun, termasuk staff Kahade. ` +
  `(Kanal: ${method})`;

class MockOtpProvider implements OtpProviderAdapter {
  constructor(private readonly logger: Logger) {}

  supportsMethod(_method: OtpDeliveryMethod): boolean {
    return true;
  }

  send(phoneNumber: string, code: string, method: OtpDeliveryMethod): Promise<OtpDeliveryResult> {
    this.logger.warn(
      `[MOCK OTP GATEWAY] Phone: ${phoneNumber}, Code: ${code}, Method: ${method} ` +
        `— set OTP_PROVIDER=fonnte|twilio with credentials to send real messages.`,
    );
    return Promise.resolve({
      success: true,
      messageId: `mock_${Date.now()}_${randomBytes(4).toString('hex')}`,
    });
  }
}

class FonnteOtpProvider implements OtpProviderAdapter {
  private readonly endpoint: string;

  constructor(
    private readonly logger: Logger,
    private readonly token: string,
    endpoint?: string,
    private readonly countryCode: string = '62',
  ) {
    this.endpoint = endpoint || 'https://api.fonnte.com/send';
  }

  // Fonnte's /send endpoint is WhatsApp-only — there is no SMS routing
  // parameter (see https://docs.fonnte.com/api-send-message/). The auth flow
  // checks this before generating an OTP so the user's cooldown isn't burned
  // when they need to retry on WhatsApp.
  supportsMethod(method: OtpDeliveryMethod): boolean {
    return method === 'WHATSAPP';
  }

  async send(phoneNumber: string, code: string, method: OtpDeliveryMethod): Promise<OtpDeliveryResult> {
    // Defensive: callers should consult supportsMethod first, but reject here
    // too so a misconfigured caller can't silently route SMS through WhatsApp.
    if (method === 'SMS') {
      this.logger.warn(
        `Fonnte does not support SMS delivery — rejecting request for ${phoneNumber}. ` +
          `Configure a separate SMS provider (e.g. Twilio) or have the user select WhatsApp.`,
      );
      return { success: false, error: 'OTP_DELIVERY_SMS_UNSUPPORTED' };
    }

    const target = this.toFonnteTarget(phoneNumber);
    const body = new URLSearchParams({
      target,
      message: DEFAULT_OTP_TEMPLATE(code, method),
      countryCode: this.countryCode,
    }).toString();

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: this.token,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Fonnte network error: ${msg}`);
      return { success: false, error: 'OTP_DELIVERY_NETWORK_ERROR' };
    }

    let json: { status?: boolean; id?: unknown; reason?: string } = {};
    try {
      json = (await res.json()) as { status?: boolean; id?: unknown; reason?: string };
    } catch {
      // ignore — handled by status check below
    }

    if (!res.ok || json.status === false) {
      this.logger.error(
        `Fonnte send failed: status=${res.status} reason=${json.reason ?? '<no reason>'}`,
      );
      return { success: false, error: json.reason || `OTP_DELIVERY_HTTP_${res.status}` };
    }

    const messageId = Array.isArray(json.id)
      ? String(json.id[0] ?? '')
      : json.id !== undefined
        ? String(json.id)
        : `fonnte_${Date.now()}`;
    return { success: true, messageId };
  }

  private toFonnteTarget(phone: string): string {
    return phone.replace(/^\+/, '');
  }
}

class TwilioOtpProvider implements OtpProviderAdapter {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromSms: string;
  private readonly fromWhatsApp: string;

  constructor(
    private readonly logger: Logger,
    accountSid: string,
    authToken: string,
    fromSms: string,
    fromWhatsApp: string,
  ) {
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.fromSms = fromSms;
    this.fromWhatsApp = fromWhatsApp;
  }

  supportsMethod(method: OtpDeliveryMethod): boolean {
    return method === 'WHATSAPP' ? !!this.fromWhatsApp : !!this.fromSms;
  }

  async send(phoneNumber: string, code: string, method: OtpDeliveryMethod): Promise<OtpDeliveryResult> {
    const from = method === 'WHATSAPP' ? this.fromWhatsApp : this.fromSms;
    if (!from) {
      this.logger.error(
        `Twilio "from" number is not configured for method=${method}. ` +
          `Set TWILIO_SMS_FROM and/or TWILIO_WHATSAPP_FROM.`,
      );
      return { success: false, error: 'OTP_DELIVERY_NOT_CONFIGURED' };
    }

    const to = method === 'WHATSAPP' ? `whatsapp:${phoneNumber}` : phoneNumber;
    const fromField =
      method === 'WHATSAPP' && !from.startsWith('whatsapp:') ? `whatsapp:${from}` : from;
    const body = new URLSearchParams({
      To: to,
      From: fromField,
      Body: DEFAULT_OTP_TEMPLATE(code, method),
    }).toString();

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Twilio network error: ${msg}`);
      return { success: false, error: 'OTP_DELIVERY_NETWORK_ERROR' };
    }

    if (!res.ok) {
      let reason: string | undefined;
      try {
        const errJson = (await res.json()) as { message?: string };
        reason = errJson?.message;
      } catch {
        // ignore — handled below
      }
      this.logger.error(`Twilio send failed: status=${res.status} reason=${reason ?? '<no reason>'}`);
      return { success: false, error: reason || `OTP_DELIVERY_HTTP_${res.status}` };
    }

    const json = (await res.json().catch(() => ({}))) as { sid?: string };
    return { success: true, messageId: json.sid ?? `twilio_${Date.now()}` };
  }
}

@Injectable()
export class OtpGatewayService {
  private readonly logger = new Logger(OtpGatewayService.name);
  private readonly provider: OtpProviderAdapter;
  private readonly providerName: OtpProviderName;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {
    const configuredProvider = (this.config.get<string>('OTP_PROVIDER') || 'mock').toLowerCase();
    const supportedProviders: OtpProviderName[] = ['mock', 'fonnte', 'twilio'];
    if (!supportedProviders.includes(configuredProvider as OtpProviderName) && this.isProductionRuntime()) {
      throw new Error(`Unsupported OTP_PROVIDER="${configuredProvider}" in production. Refusing to start auth gateway.`);
    }
    const providerName = (supportedProviders.includes(configuredProvider as OtpProviderName) ? configuredProvider : 'mock') as OtpProviderName;
    this.providerName = providerName;
    this.provider = this.buildProvider(providerName);
    this.logger.log(`OTP gateway initialized with provider=${providerName}`);
  }

  private isProductionRuntime(): boolean {
    const nodeEnv = (
      this.config.get<string>('app.nodeEnv')
      ?? this.config.get<string>('NODE_ENV')
      ?? process.env.NODE_ENV
      ?? 'development'
    ).toLowerCase();
    // Staging is internet-reachable and must have the same provider safety
    // guarantees as production. Falling back to mock in staging would make
    // authentication non-deliverable and can expose test-only behavior.
    return ['production', 'staging'].includes(nodeEnv);
  }

  async sendOtp(
    phoneNumber: string,
    code: string,
    method: OtpDeliveryMethod,
  ): Promise<OtpDeliveryResult> {
    return this.provider.send(phoneNumber, code, method);
  }

  /**
   * Returns whether the configured provider can deliver via the requested
   * channel. Callers should consult this before generating an OTP so a
   * delivery-impossible request doesn't burn the user's cooldown / rate
   * limit / DB row before failing.
   */
  supportsMethod(method: OtpDeliveryMethod): boolean {
    return this.provider.supportsMethod(method);
  }

  /**
   * Returns the full list of OTP delivery channels the configured provider
   * can fulfill. Used by the public capability endpoint so the mobile UI
   * only renders methods that will actually work against this backend.
   */
  getSupportedMethods(): OtpDeliveryMethod[] {
    const methods: OtpDeliveryMethod[] = ['SMS', 'WHATSAPP'];
    return methods.filter((m) => this.provider.supportsMethod(m));
  }

  /**
   * Returns the configured provider name (e.g. 'mock', 'fonnte', 'twilio').
   * Used by the auth flow to decide whether the dev-only `OTP_DEBUG_RETURN_CODE`
   * fallback should expose codes in API responses.
   */
  getProviderName(): OtpProviderName {
    return this.providerName;
  }

  private buildProvider(name: OtpProviderName): OtpProviderAdapter {
    switch (name) {
      case 'fonnte': {
        const token = this.config.get<string>('FONNTE_API_TOKEN');
        if (!token) {
          if (this.isProductionRuntime()) {
            throw new Error('OTP_PROVIDER=fonnte requires FONNTE_API_TOKEN in production. Refusing to start with mock fallback.');
          }
          this.logger.error(
            `OTP_PROVIDER=fonnte but FONNTE_API_TOKEN is not set — falling back to mock gateway. ` +
              `Real OTPs will NOT be delivered.`,
          );
          return new MockOtpProvider(this.logger);
        }
        return new FonnteOtpProvider(
          this.logger,
          token,
          this.config.get<string>('FONNTE_API_URL') || undefined,
          this.config.get<string>('FONNTE_COUNTRY_CODE') || '62',
        );
      }
      case 'twilio': {
        const sid = this.config.get<string>('TWILIO_ACCOUNT_SID');
        const auth = this.config.get<string>('TWILIO_AUTH_TOKEN');
        const fromSms = this.config.get<string>('TWILIO_SMS_FROM') || '';
        const fromWa = this.config.get<string>('TWILIO_WHATSAPP_FROM') || '';
        if (!sid || !auth || (!fromSms && !fromWa)) {
          if (this.isProductionRuntime()) {
            throw new Error('OTP_PROVIDER=twilio requires account credentials and at least one sender in production. Refusing to start with mock fallback.');
          }
          this.logger.error(
            `OTP_PROVIDER=twilio is missing account credentials or a sender — ` +
              `falling back to mock gateway. Real OTPs will NOT be delivered.`,
          );
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
}
