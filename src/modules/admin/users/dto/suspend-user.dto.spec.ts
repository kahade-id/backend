import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SuspendUserDto } from './suspend-user.dto';

/**
 * BAI-074 — SuspendUserDto: alasan wajib min 10 / max 500 karakter dan
 * durasi 1–720 jam. Selaras dengan guard service (ConflictException bila
 * user sudah di-suspend/di-ban).
 */
describe('SuspendUserDto', () => {
  async function validateDto(data: Record<string, unknown>) {
    return validate(plainToInstance(SuspendUserDto, data));
  }

  it('accepts a valid reason and duration', async () => {
    const errors = await validateDto({ reason: 'Investigasi dugaan penipuan', durationHours: 24 });
    expect(errors).toHaveLength(0);
  });

  it('rejects a reason shorter than 10 characters', async () => {
    const errors = await validateDto({ reason: 'pendek', durationHours: 24 });
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('rejects a whitespace-only reason', async () => {
    const errors = await validateDto({ reason: '          ', durationHours: 24 });
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('rejects a reason longer than 500 characters', async () => {
    const errors = await validateDto({ reason: 'x'.repeat(501), durationHours: 24 });
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('rejects duration below 1 hour', async () => {
    const errors = await validateDto({ reason: 'Investigasi dugaan penipuan', durationHours: 0 });
    expect(errors.some((e) => e.property === 'durationHours')).toBe(true);
  });

  it('rejects duration above 720 hours (30 days)', async () => {
    const errors = await validateDto({ reason: 'Investigasi dugaan penipuan', durationHours: 721 });
    expect(errors.some((e) => e.property === 'durationHours')).toBe(true);
  });

  it('rejects non-integer duration', async () => {
    const errors = await validateDto({ reason: 'Investigasi dugaan penipuan', durationHours: 1.5 });
    expect(errors.some((e) => e.property === 'durationHours')).toBe(true);
  });
});
