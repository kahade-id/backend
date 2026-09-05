import { ConfigService } from '@nestjs/config';
import { OtpGatewayService } from '../otp-gateway.service';

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('OtpGatewayService production safety', () => {
  it('rejects the mock provider in production', () => {
    expect(() => new OtpGatewayService(config({ NODE_ENV: 'production', OTP_PROVIDER: 'mock' }))).toThrow(
      'OTP_PROVIDER=mock is not allowed in production',
    );
  });

  it('rejects an unknown provider in production', () => {
    expect(() => new OtpGatewayService(config({ NODE_ENV: 'production', OTP_PROVIDER: 'local-debug' }))).toThrow(
      'Unsupported OTP_PROVIDER="local-debug" in production',
    );
  });

  it('rejects the mock provider in staging', () => {
    expect(() => new OtpGatewayService(config({ NODE_ENV: 'staging', OTP_PROVIDER: 'mock' }))).toThrow(
      'OTP_PROVIDER=mock is not allowed in production',
    );
  });

  it('rejects Fonnte without an API token in production instead of falling back to mock', () => {
    expect(() => new OtpGatewayService(config({ NODE_ENV: 'production', OTP_PROVIDER: 'fonnte' }))).toThrow(
      'OTP_PROVIDER=fonnte requires FONNTE_API_TOKEN in production',
    );
  });

  it('rejects Twilio without a sender in production instead of falling back to mock', () => {
    expect(() => new OtpGatewayService(config({
      NODE_ENV: 'production',
      OTP_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC-test',
      TWILIO_AUTH_TOKEN: 'secret-test',
    }))).toThrow(
      'OTP_PROVIDER=twilio requires account credentials and at least one sender in production',
    );
  });

  it('keeps mock provider available for non-production test/dev environments', () => {
    const gateway = new OtpGatewayService(config({ NODE_ENV: 'test', OTP_PROVIDER: 'mock' }));
    expect(gateway.getProviderName()).toBe('mock');
    expect(gateway.getSupportedMethods()).toEqual(['SMS', 'WHATSAPP']);
  });
});
