import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ActionLocationType } from '@prisma/client';

export interface ActionLocationQuery {
  userId?: string;
  actionType?: ActionLocationType;
  referenceType?: string;
  referenceId?: string;
  take?: number;
}

/**
 * Read API untuk tabel action_locations — akses terbatas admin.
 * Tidak ada enkripsi tambahan pada koordinat (keputusan didokumentasikan di
 * laporan implementasi): mengikuti pola akses auth_location_logs — data hanya
 * dibaca lewat guard SUPER_ADMIN/DISPUTE_ADMIN, tidak diekspos ke user biasa.
 */
@Injectable()
export class AdminActionLocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ActionLocationQuery): Promise<{ data: object[]; total: number }> {
    const take = Math.min(Math.max(query.take ?? 50, 1), 200);
    const where = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.actionType ? { actionType: query.actionType } : {}),
      ...(query.referenceType ? { referenceType: query.referenceType } : {}),
      ...(query.referenceId ? { referenceId: query.referenceId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.actionLocation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          userId: true,
          actionType: true,
          referenceType: true,
          referenceId: true,
          latitude: true,
          longitude: true,
          accuracy: true,
          source: true,
          locationDenied: true,
          ipAddress: true,
          deviceId: true,
          suspicious: true,
          createdAt: true,
        },
      }),
      this.prisma.actionLocation.count({ where }),
    ]);
    return { data: rows, total };
  }
}
