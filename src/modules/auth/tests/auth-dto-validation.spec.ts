import { validate } from 'class-validator';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import { VerifyEmailDto } from '../dto/verify-email.dto';
import { Disable2faDto } from '../dto/disable-2fa.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { RequestPhoneChangeDto } from '../dto/change-phone.dto';
import { CorrectEmailDto } from '../dto/correct-email.dto';
import { Verify2faLoginDto } from '../dto/verify-2fa-login.dto';
import { Enable2faDto } from '../dto/enable-2fa.dto';
import { RequestOtpDto } from '../dto/request-otp.dto';
import { VerifyPhoneOtpDto } from '../dto/verify-phone-otp.dto';
import { PhoneRegisterDto } from '../dto/phone-register.dto';

describe('authentication OTP DTO validation', () => {
  it.each([
    [ResetPasswordDto, { email: 'user@example.com', otp: '12ab56', newPassword: 'Password123!@', confirmPassword: 'Password123!@' }],
    [VerifyEmailDto, { email: 'user@example.com', otp: '12ab56' }],
  ])('rejects non-numeric six-character OTP values for %p', async (Dto, value) => {
    const dto = Object.assign(new Dto(), value);
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'otp')).toBe(true);
  });

  it.each([
    [ResetPasswordDto, { email: 'user@example.com', otp: '123456', newPassword: 'Password123!@', confirmPassword: 'Password123!@' }],
    [VerifyEmailDto, { email: 'user@example.com', otp: '123456' }],
  ])('accepts numeric OTP values for %p', async (Dto, value) => {
    const dto = Object.assign(new Dto(), value);
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects a non-numeric email OTP when disabling 2FA', async () => {
    const dto = Object.assign(new Disable2faDto(), {
      password: 'Password123!@',
      code: '123456',
      emailOtpCode: '12ab56',
    });
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'emailOtpCode')).toBe(true);
  });

  it.each([
    [ChangePasswordDto, {
      currentPassword: 'Password123!@', newPassword: 'NewPassword123!@', confirmPassword: 'NewPassword123!@', mfaCode: '12ab56',
    }],
    [RequestPhoneChangeDto, {
      newPhoneNumber: '+628123456789', method: 'WHATSAPP', currentPassword: 'Password123!@', mfaCode: '12ab56',
    }],
    [CorrectEmailDto, {
      newEmail: 'new@example.com', password: 'Password123!@', mfaCode: '12ab56',
    }],
    [Verify2faLoginDto, {
      tempToken: 'temp-token', code: '12ab56', deviceId: 'device-1',
    }],
    [Enable2faDto, { code: '12ab56' }],
  ])('rejects malformed MFA code at the DTO boundary for %p', async (Dto, value) => {
    const dto = Object.assign(new Dto(), value);
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === (Dto === Verify2faLoginDto || Dto === Enable2faDto ? 'code' : 'mfaCode'))).toBe(true);
  });

  it.each([
    [ChangePasswordDto, {
      currentPassword: 'Password123!@', newPassword: 'NewPassword123!@', confirmPassword: 'NewPassword123!@', mfaCode: 'A1B2C3D4E5F6G7H8',
    }],
    [RequestPhoneChangeDto, {
      newPhoneNumber: '+628123456789', method: 'WHATSAPP', currentPassword: 'Password123!@', mfaCode: '123456',
    }],
    [CorrectEmailDto, {
      newEmail: 'new@example.com', password: 'Password123!@', mfaCode: 'A1B2C3D4E5F6G7H8',
    }],
    [Verify2faLoginDto, {
      tempToken: 'temp-token', code: '123456', deviceId: 'device-1',
    }],
    [Enable2faDto, { code: '123456' }],
  ])('accepts supported MFA code formats for %p', async (Dto, value) => {
    const dto = Object.assign(new Dto(), value);
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects an empty device identifier before a 2FA login can create an unbound session', async () => {
    const dto = Object.assign(new Verify2faLoginDto(), {
      tempToken: 'temp-token',
      code: '123456',
      deviceId: '',
    });

    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'deviceId')).toBe(true);
  });

  it.each([
    [RequestOtpDto, { phoneNumber: '+628123456789', method: 'WHATSAPP', deviceId: 'bad device id' }],
    [VerifyPhoneOtpDto, { phoneNumber: '+628123456789', code: '123456', deviceId: 'bad device id' }],
    [PhoneRegisterDto, {
      tempToken: 'temp-token', fullName: 'Nama Pengguna', username: 'user.name', dateOfBirth: '1990-01-01', gender: 'PREFER_NOT_TO_SAY', email: 'user@example.com', password: 'Password123!@', pin: '123456', deviceId: 'bad device id',
    }],
  ])('rejects unsafe device identifiers at the %p boundary', async (Dto, value) => {
    const dto = Object.assign(new Dto(), value);
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'deviceId')).toBe(true);
  });

  it.each([
    [RequestOtpDto, { phoneNumber: '+628123456789', method: 'WHATSAPP', deviceId: 'Android-123e4567-e89b-12d3-a456-426614174000' }],
    [VerifyPhoneOtpDto, { phoneNumber: '+628123456789', code: '123456', deviceId: 'iOS-123e4567-e89b-12d3-a456-426614174000' }],
  ])('accepts app-generated device identifier formats for %p', async (Dto, value) => {
    const dto = Object.assign(new Dto(), value);
    expect(await validate(dto)).toHaveLength(0);
  });
});
