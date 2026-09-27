import { NotFoundException } from '@nestjs/common';
import { resolveUserInternalId } from './resolve-user-id';

/**
 * ADM-201–204: panel admin menampilkan ID publik (USR-…), sedangkan Wallet.userId
 * adalah cuid internal. Resolver menerima kedua format.
 */
describe('resolveUserInternalId', () => {
  const prisma = { user: { findFirst: jest.fn() } };

  beforeEach(() => jest.clearAllMocks());

  it('melewatkan cuid internal bila cocok dengan kolom id', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'clx123cuid' });
    const out = await resolveUserInternalId(prisma as never, 'clx123cuid');
    expect(out).toBe('clx123cuid');
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [{ id: 'clx123cuid' }, { userId: 'clx123cuid' }],
        deletedAt: null,
      },
      select: { id: true },
    });
  });

  it('meresolusi ID publik USR-… ke cuid internal', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'clx999cuid' });
    const out = await resolveUserInternalId(prisma as never, 'USR-ABC12345');
    expect(out).toBe('clx999cuid');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: 'USR-ABC12345' }, { userId: 'USR-ABC12345' }],
        }),
      }),
    );
  });

  it('men-trim whitespace sebelum resolusi', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'clx999cuid' });
    await resolveUserInternalId(prisma as never, '  USR-ABC12345  ');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ id: 'USR-ABC12345' }, { userId: 'USR-ABC12345' }],
        }),
      }),
    );
  });

  it('404 USER_NOT_FOUND bila tidak ada user cocok (fail closed)', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(resolveUserInternalId(prisma as never, 'USR-TIDAKADA')).rejects.toThrow(
      NotFoundException,
    );
    await expect(resolveUserInternalId(prisma as never, 'USR-TIDAKADA')).rejects.toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'USER_NOT_FOUND' }),
      }),
    );
  });
});
