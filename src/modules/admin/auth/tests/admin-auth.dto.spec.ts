import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminLoginDto } from '../dto/admin-login.dto';
import { AdminVerify2faDto } from '../dto/admin-verify-2fa.dto';

describe('admin authentication DTO validation', () => {
  it('accepts only an exact six-digit optional TOTP on the admin login path', async () => {
    const valid = plainToInstance(AdminLoginDto, {
      email: 'ADMIN@EXAMPLE.COM', password: 'valid-passphrase', totpToken: '123456',
    });
    const invalid = plainToInstance(AdminLoginDto, {
      email: 'admin@example.com', password: 'valid-passphrase', totpToken: '12ab56',
    });

    expect(await validate(valid)).toHaveLength(0);
    expect(await validate(invalid)).not.toHaveLength(0);
  });

  it('rejects non-numeric and overlong TOTP before temporary-token MFA verification', async () => {
    const valid = plainToInstance(AdminVerify2faDto, { tempToken: 'temp-token', totpToken: '123456' });
    const alphabetic = plainToInstance(AdminVerify2faDto, { tempToken: 'temp-token', totpToken: 'ABCDEF' });
    const overlong = plainToInstance(AdminVerify2faDto, { tempToken: 'temp-token', totpToken: '1234567' });

    expect(await validate(valid)).toHaveLength(0);
    expect(await validate(alphabetic)).not.toHaveLength(0);
    expect(await validate(overlong)).not.toHaveLength(0);
  });
});
