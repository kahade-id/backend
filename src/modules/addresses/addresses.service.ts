import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AddressLabel, Prisma } from '@prisma/client';
import * as ErrorCodes from '../../common/constants/error-codes';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';
import { encryptPii, decryptPiiSafe } from '../../common/utils/pii.util';

const ADDRESS_SELECT = {
  id: true,
  label: true,
  customLabel: true,
  recipientName: true,
  phone: true,
  addressLine: true,
  city: true,
  province: true,
  postalCode: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} as const;

type AddressRow = Prisma.AddressGetPayload<{ select: typeof ADDRESS_SELECT }>;

/**
 * Baris alamat dengan field PII terdekripsi. Field bisa null bila dekripsi
 * gagal (fail closed — decryptPiiSafe me-log insiden tanpa mengutip PII).
 */
export type DecryptedAddress = Omit<
  AddressRow,
  'recipientName' | 'phone' | 'addressLine' | 'city' | 'province' | 'postalCode'
> & {
  recipientName: string | null;
  phone: string | null;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
};

/**
 * H2 (SEC-D ronde 2): PII buku alamat WAJIB terenkripsi AES-GCM saat rest
 * (pola sama seperti phoneNumber user — encryptPii).
 *
 * Migrasi baca dua arah: nilai berformat ciphertext (`v1:...`) didekripsi;
 * nilai legacy plaintext (pra-backfill) dikembalikan apa adanya agar deploy
 * aman sebelum skrip backfill dijalankan. Ciphertext yang gagal didekripsi
 * → null (fail closed).
 */
function isEncryptedPiiFormat(value: string): boolean {
  return value.startsWith('v1:');
}

@Injectable()
export class AddressesService {
  constructor(private prisma: PrismaService) {}

  private async decryptField(value: string | null): Promise<string | null> {
    if (value == null) return null;
    if (!isEncryptedPiiFormat(value)) return value; // legacy plaintext
    return decryptPiiSafe(value);
  }

  private async toDecrypted(row: AddressRow): Promise<DecryptedAddress> {
    const [recipientName, phone, addressLine, city, province, postalCode] = await Promise.all([
      this.decryptField(row.recipientName),
      this.decryptField(row.phone),
      this.decryptField(row.addressLine),
      this.decryptField(row.city),
      this.decryptField(row.province),
      this.decryptField(row.postalCode),
    ]);
    return { ...row, recipientName, phone, addressLine, city, province, postalCode };
  }

  private async assertOwner(userId: string, id: string): Promise<AddressRow> {
    const address = await this.prisma.address.findFirst({
      where: { id, userId, deletedAt: null },
      select: ADDRESS_SELECT,
    });
    if (!address) {
      throw new NotFoundException({ code: ErrorCodes.ADDRESS_NOT_FOUND, message: 'Alamat tidak ditemukan' });
    }
    return address;
  }

  async listAddresses(userId: string, page: number, limit: number): Promise<PaginatedResponse<DecryptedAddress>> {
    const where: Prisma.AddressWhereInput = { userId, deletedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.address.findMany({
        where,
        select: ADDRESS_SELECT,
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.address.count({ where }),
    ]);
    return createPaginatedResponse(await Promise.all(rows.map((r) => this.toDecrypted(r))), total, page, limit);
  }

  async getAddress(userId: string, id: string): Promise<DecryptedAddress> {
    return this.toDecrypted(await this.assertOwner(userId, id));
  }

  async createAddress(userId: string, dto: CreateAddressDto): Promise<DecryptedAddress> {
    this.validateLabel(dto.label, dto.customLabel);
    const provincePlain = dto.province?.trim() || '';
    const [recipientName, phone, addressLine, city, postalCode] = await Promise.all([
      encryptPii(dto.recipientName.trim()),
      encryptPii(dto.phone.replace(/ /g, '')),
      encryptPii(dto.addressLine.trim()),
      encryptPii(dto.city.trim()),
      encryptPii(dto.postalCode),
    ]);
    const province = provincePlain ? await encryptPii(provincePlain) : null;
    const created = await this.prisma.$transaction(async (tx) => {
      const existingCount = await tx.address.count({ where: { userId, deletedAt: null } });
      if (existingCount >= 20) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Maksimal 20 alamat tersimpan' });
      }
      const isDefault = existingCount === 0;
      return tx.address.create({
        data: {
          userId,
          label: dto.label,
          customLabel: dto.label === AddressLabel.LAINNYA ? dto.customLabel!.trim() : null,
          recipientName,
          phone,
          addressLine,
          city,
          province,
          postalCode,
          isDefault,
        },
        select: ADDRESS_SELECT,
      });
    });
    return this.toDecrypted(created);
  }

  async updateAddress(userId: string, id: string, dto: UpdateAddressDto): Promise<DecryptedAddress> {
    const existing = await this.assertOwner(userId, id);
    const label = dto.label ?? existing.label;
    const customLabel = dto.customLabel !== undefined ? dto.customLabel : existing.customLabel;
    this.validateLabel(label, customLabel);
    const data: Prisma.AddressUpdateInput = {
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      customLabel: label === AddressLabel.LAINNYA ? customLabel!.trim() : null,
    };
    if (dto.recipientName !== undefined) data.recipientName = await encryptPii(dto.recipientName.trim());
    if (dto.phone !== undefined) data.phone = await encryptPii(dto.phone.replace(/ /g, ''));
    if (dto.addressLine !== undefined) data.addressLine = await encryptPii(dto.addressLine.trim());
    if (dto.city !== undefined) data.city = await encryptPii(dto.city.trim());
    if (dto.province !== undefined) {
      data.province = dto.province?.trim() ? await encryptPii(dto.province.trim()) : null;
    }
    if (dto.postalCode !== undefined) data.postalCode = await encryptPii(dto.postalCode);
    const updated = await this.prisma.address.update({
      where: { id: existing.id },
      data,
      select: ADDRESS_SELECT,
    });
    return this.toDecrypted(updated);
  }

  async deleteAddress(userId: string, id: string): Promise<{ id: string }> {
    const existing = await this.assertOwner(userId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.address.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isDefault: false } });
      if (existing.isDefault) {
        // Promosikan alamat terbaru sebagai default pengganti.
        const next = await tx.address.findFirst({
          where: { userId, deletedAt: null },
          orderBy: { updatedAt: 'desc' },
          select: { id: true },
        });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
    return { id: existing.id };
  }

  /** Set satu alamat sebagai default (fail closed: harus milik user). */
  async setDefaultAddress(userId: string, id: string): Promise<DecryptedAddress> {
    const existing = await this.assertOwner(userId, id);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.address.updateMany({ where: { userId, deletedAt: null, isDefault: true }, data: { isDefault: false } });
      return tx.address.update({ where: { id: existing.id }, data: { isDefault: true }, select: ADDRESS_SELECT });
    });
    return this.toDecrypted(updated);
  }

  private validateLabel(label: AddressLabel, customLabel?: string | null): void {
    if (label === AddressLabel.LAINNYA && (!customLabel || !customLabel.trim())) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Label custom wajib diisi bila label = LAINNYA',
      });
    }
  }
}
