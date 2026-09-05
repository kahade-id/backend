import { validate } from 'class-validator';
import { TrustDeviceDto } from '../dto/trust-device.dto';

describe('TrustDeviceDto', () => {
  it.each(['12ab56', '12345', '1234567', 'A1B2C3D4E5F6G7H8'])('rejects malformed authenticator code %s', async (mfaCode) => {
    const dto = Object.assign(new TrustDeviceDto(), { password: 'Password123!@', mfaCode });
    const errors = await validate(dto);

    expect(errors.some((error) => error.property === 'mfaCode')).toBe(true);
  });

  it('accepts an exact six-digit authenticator code', async () => {
    const dto = Object.assign(new TrustDeviceDto(), { password: 'Password123!@', mfaCode: '123456' });
    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });
});
