import { ConfigService } from '@nestjs/config';
import { OtpGatewayService } from '../otp-gateway.service';
import { OpsSettingsService } from '../../ops-settings/ops-settings.service';

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function opsSettings(values: Record<string, string | undefined>): OpsSettingsService {
  return {
    get: jest.fn((key: string) => values[key]),
    getSecret: jest.fn((key: string) => values[key]),
    has: jest.fn((key: string) => !!values[key]),
  } as unknown as OpsSettingsService;
}

describe('OtpGatewayService production safety', () => {
  it('rejects the mock provider in production', () => {
    expect(
      () =>
        new OtpGatewayService(
          config({ NODE_ENV: 'production', OTP_PROVIDER: 'mock' }),
          opsSettings({}),
        ),
    ).toThrow('OTP_PROVIDER=mock is not allowed in production');
  });

  it('rejects an unknown provider in production', () => {
    expect(
      () =>
        new OtpGatewayService(
          config({ NODE_ENV: 'production', OTP_PROVIDER: 'local-debug' }),
          opsSettings({}),
        ),
    ).toThrow('Unsupported OTP_PROVIDER="local-debug" in production');
  });

  it('rejects the mock provider in staging', () => {
    expect(
      () =>
        new OtpGatewayService(
          config({ NODE_ENV: 'staging', OTP_PROVIDER: 'mock' }),
          opsSettings({}),
        ),
    ).toThrow('OTP_PROVIDER=mock is not allowed in production');
  });

  it('rejects Twilio without a sender in production instead of falling back to mock', () => {
    expect(
      () =>
        new OtpGatewayService(
          config({
            NODE_ENV: 'production',
            OTP_PROVIDER: 'twilio',
            TWILIO_ACCOUNT_SID: 'AC-test',
            TWILIO_AUTH_TOKEN: 'tok-test',
          }),
          opsSettings({}),
        ),
    ).toThrow('OTP_PROVIDER=twilio requires account credentials and at least one sender in production');
  });

  it('keeps mock provider available for non-production test/dev environments', () => {
    const gateway = new OtpGatewayService(
      config({ NODE_ENV: 'test', OTP_PROVIDER: 'mock' }),
      opsSettings({}),
    );
    expect(gateway.getProviderName()).toBe('mock');
    expect(gateway.getSupportedMethods()).toEqual(['SMS', 'WHATSAPP']);
  });

  describe('OPS — dynamic Fonnte token (no restart rotation)', () => {
    const realFetch = global.fetch;

    beforeEach(() => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ status: true }), { status: 200 })) as any;
    });

    afterEach(() => {
      global.fetch = realFetch;
    });

    it('boots in production without token but fails sends explicitly (fail-closed, no silent mock)', async () => {
      const gateway = new OtpGatewayService(
        config({ NODE_ENV: 'production', OTP_PROVIDER: 'fonnte' }),
        opsSettings({}),
      );
      expect(gateway.getProviderName()).toBe('fonnte');
      const result = await gateway.sendOtp('081234567890', '123456', 'WHATSAPP');
      expect(result.success).toBe(false);
      expect(result.error).toBe('OTP_PROVIDER_NOT_CONFIGURED');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('reads the token per send — rotation via panel applies without restart', async () => {
      const values: Record<string, string | undefined> = { FONNTE_API_TOKEN: 'token-pertama' };
      const gateway = new OtpGatewayService(
        config({ NODE_ENV: 'production', OTP_PROVIDER: 'fonnte' }),
        opsSettings(values),
      );
      await gateway.sendOtp('081234567890', '123456', 'WHATSAPP');
      expect((global.fetch as jest.Mock).mock.calls[0][1].headers.Authorization).toBe('token-pertama');

      // Rotasi token (seperti via admin panel) — pengiriman berikutnya pakai token baru.
      values.FONNTE_API_TOKEN = 'token-kedua';
      await gateway.sendOtp('081234567890', '123456', 'WHATSAPP');
      expect((global.fetch as jest.Mock).mock.calls[1][1].headers.Authorization).toBe('token-kedua');
    });
  });
});
