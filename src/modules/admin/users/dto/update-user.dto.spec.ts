import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateUserDto } from './update-user.dto';

/**
 * BAI-071 — UpdateUserDto: whitelist field terbatas. Hanya `accountType`
 * (PERSONAL|BUSINESS) yang diterima; field di luar whitelist ditolak oleh
 * ValidationPipe global (forbidNonWhitelisted) di level controller.
 */
describe('UpdateUserDto', () => {
  async function validateDto(data: Record<string, unknown>) {
    return validate(plainToInstance(UpdateUserDto, data));
  }

  it('accepts PERSONAL and BUSINESS', async () => {
    expect(await validateDto({ accountType: 'PERSONAL' })).toHaveLength(0);
    expect(await validateDto({ accountType: 'BUSINESS' })).toHaveLength(0);
  });

  it('accepts an empty body (no changes → service menolak 422)', async () => {
    expect(await validateDto({})).toHaveLength(0);
  });

  it('rejects an unknown accountType', async () => {
    const errors = await validateDto({ accountType: 'ENTERPRISE' });
    expect(errors.some((e) => e.property === 'accountType')).toBe(true);
  });
});
