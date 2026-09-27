import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminVouchersService } from './admin-vouchers.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

/**
 * ADM-218 — reaktivasi voucher (flag lunak isActive).
 * Membuktikan:
 *  1. Voucher tidak ada → 404 VOUCHER_NOT_FOUND.
 *  2. Masih aktif → 400 (tidak ada yang berubah).
 *  3. Sudah kedaluwarsa → 400 fail-closed (aktif pun tak bisa dipakai).
 *  4. Nonaktif & masih berlaku → aktif kembali + audit VOUCHER_REACTIVATED.
 */
describe('AdminVouchersService.reactivateVoucher (ADM-218)', () => {
  const prisma = {
    voucher: {
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const redis = { del: jest.fn(), delPattern: jest.fn(async () => 0) };
  const auditLog = { logAdminAction: jest.fn().mockResolvedValue(undefined) };

  const makeService = () =>
    new AdminVouchersService(prisma as never, redis as never, auditLog as never);

  const makeVoucher = (overrides: Record<string, unknown> = {}) => ({
    id: 'v-internal-1',
    voucherId: 'VCH-TEST',
    code: 'TEST10',
    isActive: false,
    validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    discountAmount: null,
    maxDiscountAmount: null,
    minOrderValue: null,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.voucher.updateMany.mockResolvedValue({ count: 1 });
  });

  it('404 bila voucher tidak ditemukan', async () => {
    prisma.voucher.findFirst.mockResolvedValue(null);
    const svc = makeService();
    const err = await svc.reactivateVoucher('nope', 'admin-1', '127.0.0.1').catch(e => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.response.code).toBe(ErrorCodes.VOUCHER_NOT_FOUND);
    expect(prisma.voucher.updateMany).not.toHaveBeenCalled();
  });

  it('400 bila voucher masih aktif (tidak ada yang berubah)', async () => {
    prisma.voucher.findFirst.mockResolvedValue(makeVoucher({ isActive: true }));
    const svc = makeService();
    const err = await svc.reactivateVoucher('VCH-TEST', 'admin-1', '127.0.0.1').catch(e => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.response.code).toBe(ErrorCodes.INVALID_STATUS);
    expect(prisma.voucher.updateMany).not.toHaveBeenCalled();
    expect(auditLog.logAdminAction).not.toHaveBeenCalled();
  });

  it('400 fail-closed bila voucher sudah kedaluwarsa', async () => {
    prisma.voucher.findFirst.mockResolvedValue(
      makeVoucher({ validUntil: new Date(Date.now() - 1000) }),
    );
    const svc = makeService();
    const err = await svc.reactivateVoucher('VCH-TEST', 'admin-1', '127.0.0.1').catch(e => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.response.code).toBe(ErrorCodes.INVALID_STATUS);
    expect(prisma.voucher.updateMany).not.toHaveBeenCalled();
    expect(auditLog.logAdminAction).not.toHaveBeenCalled();
  });

  it('voucher nonaktif & masih berlaku → aktif kembali + audit VOUCHER_REACTIVATED', async () => {
    const voucher = makeVoucher();
    prisma.voucher.findFirst.mockResolvedValue(voucher);
    prisma.voucher.findUniqueOrThrow.mockResolvedValue({ ...voucher, isActive: true });
    const svc = makeService();
    await svc.reactivateVoucher('VCH-TEST', 'admin-1', '127.0.0.1');
    expect(prisma.voucher.updateMany).toHaveBeenCalledWith({
      where: { id: 'v-internal-1', isActive: false },
      data: { isActive: true, deactivatedBy: null, deactivatedAt: null },
    });
    expect(auditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'VOUCHER_REACTIVATED',
        targetType: 'Voucher',
        targetId: 'v-internal-1',
      }),
    );
  });

  it('race: updateMany count 0 → 400 (sudah aktif oleh admin lain)', async () => {
    prisma.voucher.findFirst.mockResolvedValue(makeVoucher());
    prisma.voucher.updateMany.mockResolvedValue({ count: 0 });
    const svc = makeService();
    const err = await svc.reactivateVoucher('VCH-TEST', 'admin-1', '127.0.0.1').catch(e => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(auditLog.logAdminAction).not.toHaveBeenCalled();
  });
});
