import { BadRequestException } from '@nestjs/common';
import {
  validatePasswordPolicy,
  isCommonPassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} from './password-policy';
import * as ErrorCodes from '../../common/constants/error-codes';

/** SYS-C-202: penolakan blocklist harus memakai kode error spesifik. */
describe('password-policy blocklist', () => {
  it('menolak password umum dengan kode PASSWORD_TOO_COMMON', () => {
    for (const pw of ['password123', 'Kahade123', 'bismillah']) {
      try {
        validatePasswordPolicy(pw);
        fail(`seharusnya menolak: ${pw}`);
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        const body = (e as BadRequestException).getResponse() as { code?: string };
        expect(body.code).toBe(ErrorCodes.PASSWORD_TOO_COMMON);
        expect(body.code).not.toBe(ErrorCodes.VALIDATION_ERROR);
      }
    }
  });

  it('isCommonPassword case-insensitive', () => {
    expect(isCommonPassword('PASSWORD123')).toBe(true);
    expect(isCommonPassword('xK7!mQ9#vL2')).toBe(false);
  });

  it('panjang tetap VALIDATION_ERROR (bukan blocklist)', () => {
    const short = 'ab';
    try {
      validatePasswordPolicy(short);
      fail('seharusnya menolak password pendek');
    } catch (e) {
      const body = (e as BadRequestException).getResponse() as { code?: string };
      expect(body.code).toBe(ErrorCodes.VALIDATION_ERROR);
    }
    const long = 'a'.repeat(PASSWORD_MAX_LENGTH + 1);
    expect(() => validatePasswordPolicy(long)).toThrow(BadRequestException);
  });

  it(`batas panjang: ${PASSWORD_MIN_LENGTH}/${PASSWORD_MAX_LENGTH}`, () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(72);
  });
});
