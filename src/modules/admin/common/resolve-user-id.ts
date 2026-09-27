import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import * as ErrorCodes from '../../../common/constants/error-codes';

/**
 * ADM-201–204: resolusi ID pengguna dua format untuk endpoint admin keuangan.
 *
 * Panel admin di mana-mana menampilkan ID publik (`USR-XXXXXXXX`, kolom
 * `User.userId`), sementara `Wallet.userId` adalah FK ke `User.id` (cuid
 * internal). Tanpa resolusi, setiap endpoint yang menerima ID user dari
 * admin selalu 404 bila diberi ID publik.
 *
 * Fungsi ini menerima kedua format (cuid internal ATAU `USR-…`) dan
 * mengembalikan cuid internal — pola yang sama dengan
 * `AdminUsersService.resolveUserId`. Soft-deleted user ditolak.
 */
export async function resolveUserInternalId(
  prisma: PrismaService,
  userId: string,
): Promise<string> {
  const normalized = userId.trim();
  const user = await prisma.user.findFirst({
    where: { OR: [{ id: normalized }, { userId: normalized }], deletedAt: null },
    select: { id: true },
  });
  if (!user) {
    throw new NotFoundException({
      code: ErrorCodes.USER_NOT_FOUND,
      message: 'User tidak ditemukan',
    });
  }
  return user.id;
}
