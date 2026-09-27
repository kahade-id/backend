/**
 * GAP-D retur — jembatan akses Prisma.
 *
 * Sampai client Prisma di-regenerate pasca-merge skema gap-D, akses model
 * retur dilakukan lewat facade ini (cast terkontrol di satu tempat).
 * Setelah merge: hapus file ini, pakai `this.prisma.returnRequest` langsung.
 */
import type { PrismaService } from '../../prisma/prisma.service';
import type { ReturnsDb } from './returns.types';

export function getReturnsDb(prisma: PrismaService): ReturnsDb {
  const p = prisma as unknown as Record<string, unknown>;
  const need = (name: string) => {
    const delegate = p[name];
    if (!delegate) {
      throw new Error(
        `Model Prisma '${name}' belum tersedia — regenerate @prisma/client setelah merge schema-gap-d-returns.prisma.`,
      );
    }
    return delegate;
  };
  return {
    returnPolicy: need('returnPolicy'),
    returnRequest: need('returnRequest'),
    returnAttachment: need('returnAttachment'),
    returnNote: need('returnNote'),
    returnTimeline: need('returnTimeline'),
    returnShipmentEvent: need('returnShipmentEvent'),
    returnRefundApproval: need('returnRefundApproval'),
  } as ReturnsDb;
}
