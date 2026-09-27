import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PayOrderDto, CancelOrderDto, ConfirmReceiptDto } from '../../orders/dto/order-actions.dto';
import { EscalateDisputeDto } from '../../disputes/dto/escalate-dispute.dto';
import { WithdrawDto } from '../../wallet/dto/withdraw.dto';
import { SetPinDto } from '../../wallet/dto/wallet-pin.dto';
import { ConfirmPhoneChangeDto } from '../../auth/dto/change-phone.dto';

// Validasi deviceLocation di DTO aksi sensitif.
// Koordinat di luar rentang → error validasi (menjadi 400 di API via
// ValidationPipe global). Lokasi null/absent → lolos (user menolak GPS).

async function violations(dto: object): Promise<string[]> {
  const errors = await validate(dto as object);
  return errors.flatMap((e) => {
    const nested = e.children?.flatMap((c) => Object.values(c.constraints ?? {})) ?? [];
    return [...Object.values(e.constraints ?? {}), ...nested];
  });
}

describe('deviceLocation validation (aksi sensitif)', () => {
  it('PayOrderDto: latitude 91 ditolak', async () => {
    const dto = plainToInstance(PayOrderDto, {
      pin: '123456',
      deviceLocation: { latitude: 91, longitude: 106.85 },
    });
    const v = await violations(dto);
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(' ')).toMatch(/latitude/i);
  });

  it('PayOrderDto: longitude -181 ditolak', async () => {
    const dto = plainToInstance(PayOrderDto, {
      pin: '123456',
      deviceLocation: { latitude: -6.2, longitude: -181 },
    });
    const v = await violations(dto);
    expect(v.length).toBeGreaterThan(0);
    expect(v.join(' ')).toMatch(/longitude/i);
  });

  it('PayOrderDto: accuracy negatif ditolak', async () => {
    const dto = plainToInstance(PayOrderDto, {
      pin: '123456',
      deviceLocation: { latitude: -6.2, longitude: 106.85, accuracy: -1 },
    });
    expect((await violations(dto)).length).toBeGreaterThan(0);
  });

  it('PayOrderDto: lokasi valid lolos', async () => {
    const dto = plainToInstance(PayOrderDto, {
      pin: '123456',
      deviceLocation: { latitude: -6.2, longitude: 106.85, accuracy: 12.5, source: 'gps' },
    });
    expect(await violations(dto)).toHaveLength(0);
  });

  it('PayOrderDto: tanpa deviceLocation lolos (user menolak GPS)', async () => {
    const dto = plainToInstance(PayOrderDto, { pin: '123456' });
    expect(await violations(dto)).toHaveLength(0);
  });

  it('PayOrderDto: deviceLocation null lolos', async () => {
    const dto = plainToInstance(PayOrderDto, { pin: '123456', deviceLocation: null });
    expect(await violations(dto)).toHaveLength(0);
  });

  it('CancelOrderDto: latitude di batas ±90 lolos, 90.001 ditolak', async () => {
    const ok = plainToInstance(CancelOrderDto, {
      reason: 'CHANGED_MIND',
      deviceLocation: { latitude: 90, longitude: 180 },
    });
    expect(await violations(ok)).toHaveLength(0);
    const bad = plainToInstance(CancelOrderDto, {
      reason: 'CHANGED_MIND',
      deviceLocation: { latitude: 90.001, longitude: 180 },
    });
    expect((await violations(bad)).length).toBeGreaterThan(0);
  });

  it('ConfirmReceiptDto (body opsional): kosong lolos, lokasi invalid ditolak', async () => {
    const empty = plainToInstance(ConfirmReceiptDto, {});
    expect(await violations(empty)).toHaveLength(0);
    const bad = plainToInstance(ConfirmReceiptDto, {
      deviceLocation: { latitude: -200, longitude: 106.85 },
    });
    expect((await violations(bad)).length).toBeGreaterThan(0);
  });

  it('EscalateDisputeDto: lokasi invalid ditolak, valid lolos', async () => {
    const bad = plainToInstance(EscalateDisputeDto, {
      reason: 'alasan banding',
      deviceLocation: { latitude: -6.2, longitude: 106.85, accuracy: 200000 },
    });
    expect((await violations(bad)).length).toBeGreaterThan(0);
    const ok = plainToInstance(EscalateDisputeDto, {
      deviceLocation: { latitude: -6.2, longitude: 106.85 },
    });
    expect(await violations(ok)).toHaveLength(0);
  });

  it('WithdrawDto: lokasi valid lolos', async () => {
    const dto = plainToInstance(WithdrawDto, {
      amount: 100000,
      bankAccountId: 'BA-abc123XYZ',
      pin: '123456',
      deviceLocation: { latitude: -6.2, longitude: 106.85, source: 'fused' },
    });
    expect(await violations(dto)).toHaveLength(0);
  });

  it('SetPinDto: koordinat string (bukan number) ditolak setelah transform', async () => {
    const dto = plainToInstance(SetPinDto, {
      pin: '123456',
      password: 'secretpw',
      deviceLocation: { latitude: 'bukan-angka', longitude: 106.85 },
    });
    // @Type(() => Number) mengubah 'bukan-angka' → NaN → @IsNumber gagal.
    expect((await violations(dto)).length).toBeGreaterThan(0);
  });

  it('ConfirmPhoneChangeDto: lokasi invalid ditolak', async () => {
    const dto = plainToInstance(ConfirmPhoneChangeDto, {
      newPhoneNumber: '6281234567890',
      code: '123456',
      deviceLocation: { latitude: -6.2, longitude: 190 },
    });
    expect((await violations(dto)).length).toBeGreaterThan(0);
  });
});
