/**
 * GAP-E G380 — validasi DTO ekspor CSV: `reason` WAJIB (tanpa reason → 400
 * di ValidationPipe sebelum service dipanggil).
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UserExportQueryDto } from '../dto/user-export-query.dto';

describe('UserExportQueryDto — reason wajib', () => {
  const toDto = (q: object): UserExportQueryDto => plainToInstance(UserExportQueryDto, q);

  it('menolak reason yang hilang (→ 400)', async () => {
    const errors = await validate(toDto({}));
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('menolak reason kosong (→ 400)', async () => {
    const errors = await validate(toDto({ reason: '' }));
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('menolak reason lebih pendek dari 10 karakter (→ 400)', async () => {
    const errors = await validate(toDto({ reason: 'audit' }));
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('menerima reason valid tanpa kolom lain', async () => {
    const errors = await validate(toDto({ reason: 'Investigasi laporan penipuan #123' }));
    expect(errors).toHaveLength(0);
  });

  it('mask default true bila tidak diisi (query string kosong)', async () => {
    const dto = toDto({ reason: 'Investigasi laporan penipuan #123' });
    expect(dto.mask).toBeUndefined(); // service memperlakukan undefined sebagai true
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
