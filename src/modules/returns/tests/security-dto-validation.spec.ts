/**
 * SEC-203/SEC-204 — validasi DTO ketat untuk body yang sebelumnya inline.
 *
 * SEC-203: ResolveReturnDto menolak outcome tak dikenal (dulu diam-diam
 *          jatuh ke penyelesaian REPAIR di service).
 * SEC-204: AddBillLinesDto memvalidasi nested BillLineDto — billedAmount
 *          NaN/negatif dan lines non-array ditolak sebelum BigInt/rekonsiliasi.
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ResolveReturnDto } from '../dto/returns.dto';
import { AddBillLinesDto } from '../../courier/dto/courier.dto';

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

describe('SEC-204 AddBillLinesDto', () => {
  it('menerima lines valid', async () => {
    const v = await violationsOf(AddBillLinesDto, {
      lines: [{ trackingNumber: 'RESI1', billedAmount: 15000 }],
    });
    expect(v).toHaveLength(0);
  });

  it('menolak billedAmount negatif', async () => {
    const v = await violationsOf(AddBillLinesDto, { lines: [{ billedAmount: -1 }] });
    expect(v.length).toBeGreaterThan(0);
  });

  it('menolak billedAmount NaN / non-number', async () => {
    for (const billedAmount of [NaN, '15000', null]) {
      const v = await violationsOf(AddBillLinesDto, { lines: [{ billedAmount }] });
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it('menolak lines kosong / bukan array / melebihi batas', async () => {
    expect((await violationsOf(AddBillLinesDto, { lines: [] })).length).toBeGreaterThan(0);
    expect((await violationsOf(AddBillLinesDto, { lines: 'x' })).length).toBeGreaterThan(0);
    expect((await violationsOf(AddBillLinesDto, {})).length).toBeGreaterThan(0);
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ billedAmount: i + 1 }));
    expect((await violationsOf(AddBillLinesDto, { lines: tooMany })).length).toBeGreaterThan(0);
  });

  it('menolak trackingNumber terlalu panjang', async () => {
    const v = await violationsOf(AddBillLinesDto, {
      lines: [{ trackingNumber: 'x'.repeat(101), billedAmount: 100 }],
    });
    expect(v.length).toBeGreaterThan(0);
  });
});
