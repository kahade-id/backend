import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateOrderDto } from '../dto/create-order.dto';
import { OrderType, FeeResponsibility, FulfillmentType, ParticipantMode, OrderCategory } from '@prisma/client';

/**
 * TX-AUDIT2 (P0-A): seluruh field yang dikirim frontend "Buat Transaksi"
 * HARUS diterima CreateOrderDto — global ValidationPipe memakai
 * whitelist+forbidNonWhitelisted, sehingga field yang tidak dideklarasikan
 * = 422 untuk SEMUA kategori.
 */
describe('CreateOrderDto — TX-UNIFIED-V2 category fields (P0-A)', () => {
  function baseDto() {
    return {
      role: 'BUYER',
      counterpartUsername: 'seller01',
      title: 'Test Order Title',
      description: 'Test description yang cukup panjang untuk lolos validasi',
      orderType: OrderType.PHYSICAL_GOODS,
      orderValue: 100000,
      deliveryDeadlineDays: 7,
      feeResponsibility: FeeResponsibility.BUYER,
      fulfillment: FulfillmentType.BIASA,
      participantMode: ParticipantMode.SINGLE,
      category: OrderCategory.FISIK,
    };
  }

  async function validateDto(payload: Record<string, unknown>) {
    const dto = plainToInstance(CreateOrderDto, payload);
    return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  }

  it('menerima field FISIK: itemCondition + conditionDescription', async () => {
    const errors = await validateDto({
      ...baseDto(),
      itemCondition: 'bekas',
      conditionDescription: 'Lecet dikit',
    });
    expect(errors).toHaveLength(0);
  });

  it('menerima field DIGITAL: deliveryMethod + warrantyDays', async () => {
    const errors = await validateDto({
      ...baseDto(),
      orderType: OrderType.DIGITAL_GOODS,
      category: OrderCategory.DIGITAL,
      deliveryMethod: 'kode',
      warrantyDays: 30,
    });
    expect(errors).toHaveLength(0);
  });

  it('menerima field JASA: scheduledDate + deliverables + serviceLocation + cancellationPolicy + slotId', async () => {
    const errors = await validateDto({
      ...baseDto(),
      orderType: OrderType.SERVICE,
      category: OrderCategory.JASA,
      scheduledDate: '2026-10-15',
      deliverables: 'Desain logo',
      serviceLocation: 'Jakarta',
      cancellationPolicy: 'H-3 refund',
      slotId: 'slot-123',
    });
    expect(errors).toHaveLength(0);
  });

  it('menerima preorderEstimatedDate', async () => {
    const errors = await validateDto({
      ...baseDto(),
      fulfillment: FulfillmentType.PREORDER,
      preorderEstimatedDate: '2026-11-01',
    });
    expect(errors).toHaveLength(0);
  });

  it('tetap menolak field yang tidak dikenal (whitelist aktif)', async () => {
    const errors = await validateDto({ ...baseDto(), unknownField: 'x' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('menolak warrantyDays negatif', async () => {
    const errors = await validateDto({ ...baseDto(), warrantyDays: -5 });
    expect(errors.length).toBeGreaterThan(0);
  });
});
