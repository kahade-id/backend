/**
 * GAP-D stok — jembatan akses Prisma (G251–G275).
 *
 * Sampai client Prisma di-regenerate pasca-merge schema-gap-d-stock.prisma,
 * akses model stok dilakukan lewat facade ini (cast terkontrol di satu tempat).
 * Setelah merge: hapus file ini, pakai `this.prisma.product` dkk. langsung.
 */
import type { PrismaService } from '../../prisma/prisma.service';
import type { InventoryDb } from './inventory.types';

const MODEL_NAMES = [
  'product',
  'productVariant',
  'orderItem',
  'stockReservation',
  'stockMovement',
  'inventoryOperation',
  'productModerationEvent',
] as const;

export function getInventoryDb(prisma: PrismaService): InventoryDb {
  const p = prisma as unknown as Record<string, unknown>;
  const need = (name: string) => {
    const delegate = p[name];
    if (!delegate) {
      throw new Error(
        `Model Prisma '${name}' belum tersedia — regenerate @prisma/client setelah merge schema-gap-d-stock.prisma.`,
      );
    }
    return delegate;
  };
  const db = {} as Record<string, unknown>;
  for (const name of MODEL_NAMES) {
    db[name] = need(name);
  }
  return db as unknown as InventoryDb;
}
