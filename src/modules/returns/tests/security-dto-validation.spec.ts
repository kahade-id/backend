/**
 * SEC-203 — validasi DTO ketat untuk body yang sebelumnya inline.
 *
 * SEC-203: ResolveReturnDto menolak outcome tak dikenal (dulu diam-diam
 *          jatuh ke penyelesaian REPAIR di service).
 *
 * (SEC-204 dihapus SYS-D-002 2026-10-03: AddBillLinesDto ikut terhapus
 * bersama endpoint POST /v1/admin/courier/bills/:id/lines yang mati.)
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ResolveReturnDto } from '../dto/returns.dto';

async function violationsOf<T extends object>(cls: new () => T, plain: unknown): Promise<string[]> {
  const dto = plainToInstance(cls, plain);
  const errors = await validate(dto, { whitelist: true });
  const flat: string[] = [];
  const walk = (errs: typeof errors) => {
    for (const e of errs) {
      flat.push(...Object.values(e.constraints ?? {}));
      if (e.children?.length) walk(e.children);
    }
  };
  walk(errors);
  return flat;
}

describe('SEC-203 ResolveReturnDto', () => {
  it('menerima outcome valid + note opsional', async () => {
    expect(await violationsOf(ResolveReturnDto, { outcome: 'REFUND', note: 'ok' })).toHaveLength(0);
    expect(await violationsOf(ResolveReturnDto, {})).toHaveLength(0);
    expect(await violationsOf(ResolveReturnDto, { outcome: 'EXCHANGE' })).toHaveLength(0);
    expect(await violationsOf(ResolveReturnDto, { outcome: 'REPAIR' })).toHaveLength(0);
  });

  it('menolak outcome tak dikenal (dulu jatuh diam-diam ke REPAIR)', async () => {
    for (const outcome of ['FULL_REFUND', 'refund', 'CANCEL', '', 123]) {
      const v = await violationsOf(ResolveReturnDto, { outcome });
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('menolak note bukan string / terlalu panjang', async () => {
    expect((await violationsOf(ResolveReturnDto, { note: 123 })).length).toBeGreaterThan(0);
    expect((await violationsOf(ResolveReturnDto, { note: 'x'.repeat(1001) })).length).toBeGreaterThan(0);
  });
});
