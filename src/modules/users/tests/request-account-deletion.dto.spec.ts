import { validate } from 'class-validator';
import { RequestAccountDeletionDto } from '../dto/request-account-deletion.dto';

describe('RequestAccountDeletionDto', () => {
  it.each(['123456', 'A1B2C3D4E5F6G7H8'])('accepts a supported second-factor format %s', async (mfaCode) => {
    const dto = Object.assign(new RequestAccountDeletionDto(), { password: 'Password123!@', mfaCode });

    expect(await validate(dto)).toHaveLength(0);
  });

  it.each(['12ab56', '12345', '1234567', 'A1B2!C3D4'])('rejects malformed second-factor input %s', async (mfaCode) => {
    const dto = Object.assign(new RequestAccountDeletionDto(), { password: 'Password123!@', mfaCode });
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'mfaCode')).toBe(true);
  });
});
