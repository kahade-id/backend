import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { JoinPatunganDto, LinkPatunganOrderDto } from '../dto/commerce.dto';

/**
 * Wave 3 — SEC-B LOW #1 (squatting orderId di joinGroup) & SEC-C I1 (DTO linkOrder).
 * JoinPatunganDto tidak lagi punya field orderId: penautan order WAJIB lewat
 * linkOrder yang memvalidasi kepemilikan/seller/nilai/status. Global
 * ValidationPipe memakai whitelist + forbidNonWhitelisted, jadi klien yang
 * mengirim orderId di join ditolak 400 — diuji di sini dengan opsi yang sama.
 */
describe('commerce DTO validation (patungan join/link)', () => {
  it('JoinPatunganDto menolak field orderId asing (anti squatting)', async () => {
    const dto = Object.assign(new JoinPatunganDto(), { orderId: 'order-milik-orang' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some((e) => e.property === 'orderId')).toBe(true);
  });

  it('JoinPatunganDto menerima body normal tanpa orderId', async () => {
    const dto = Object.assign(new JoinPatunganDto(), { amountIdr: 50000 });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it('LinkPatunganOrderDto menolak orderId kosong / spasi saja (SEC-C I1)', async () => {
    for (const bad of ['', '   ']) {
      // plainToInstance agar @Transform trim ikut jalan seperti ValidationPipe.
      const dto = plainToInstance(LinkPatunganOrderDto, { orderId: bad });
      const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      expect(errors.some((e) => e.property === 'orderId')).toBe(true);
    }
  });

  it('LinkPatunganOrderDto menerima orderId valid', async () => {
    const dto = plainToInstance(LinkPatunganOrderDto, { orderId: 'ORD-20260928-0001' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });
});
