/**
 * GAP-E G380 — validasi DTO body POST /v1/admin/users/export:
 * `reason` WAJIB (tanpa reason → 400 di ValidationPipe),
 * `columns` array string, `mask` boolean opsional.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UserExportBodyDto } from '../dto/user-export-body.dto';

describe('UserExportBodyDto — reason wajib (POST /v1/admin/users/export)', () => {
  const toDto = (b: object): UserExportBodyDto => plainToInstance(UserExportBodyDto, b);

  it('menolak reason yang hilang (→ 400)', async () => {
    const errors = await validate(toDto({}));
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('menolak reason lebih pendek dari 10 karakter (→ 400)', async () => {
    const errors = await validate(toDto({ reason: 'audit' }));
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('menerima body valid dengan kolom array', async () => {
    const dto = toDto({
      reason: 'Investigasi laporan penipuan #123',
      columns: ['fullName', 'email', 'kycStatus'],
      mask: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.reason).toBe('Investigasi laporan penipuan #123');
  });

  it('menolak columns non-array (→ 400)', async () => {
    const errors = await validate(
      toDto({ reason: 'Investigasi laporan penipuan #123', columns: 'email,fullName' }),
    );
    expect(errors.some((e) => e.property === 'columns')).toBe(true);
  });

  it('mask opsional (undefined = default true di service)', async () => {
    const dto = toDto({ reason: 'Investigasi laporan penipuan #123' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.mask).toBeUndefined();
  });
});
