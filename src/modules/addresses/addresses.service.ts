import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AddressLabel, Prisma } from '@prisma/client';
import * as ErrorCodes from '../../common/constants/error-codes';
import { createPaginatedResponse, PaginatedResponse } from '../../common/dto/pagination.dto';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

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
 * BE-COMMERCE (2026-10-01): buku alamat user.
 * Satu alamat default per user; alamat pertama otomatis jadi default.
 */
@Injectable()
export class AddressesService {
  constructor(private prisma: PrismaService) {}

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

  async listAddresses(userId: string, page: number, limit: number): Promise<PaginatedResponse<AddressRow>> {
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
    return createPaginatedResponse(rows, total, page, limit);
  }

  async getAddress(userId: string, id: string): Promise<AddressRow> {
    return this.assertOwner(userId, id);
  }

  async createAddress(userId: string, dto: CreateAddressDto): Promise<AddressRow> {
    this.validateLabel(dto.label, dto.customLabel);
    return this.prisma.$transaction(async (tx) => {
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
          recipientName: dto.recipientName.trim(),
          phone: dto.phone.replace(/ /g, ''),
          addressLine: dto.addressLine.trim(),
          city: dto.city.trim(),
          province: dto.province?.trim() || null,
          postalCode: dto.postalCode,
          isDefault,
        },
        select: ADDRESS_SELECT,
      });
    });
  }

  async updateAddress(userId: string, id: string, dto: UpdateAddressDto): Promise<AddressRow> {
    const existing = await this.assertOwner(userId, id);
    const label = dto.label ?? existing.label;
    const customLabel = dto.customLabel !== undefined ? dto.customLabel : existing.customLabel;
    this.validateLabel(label, customLabel);
    return this.prisma.address.update({
      where: { id: existing.id },
      data: {
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        customLabel: label === AddressLabel.LAINNYA ? customLabel!.trim() : null,
        ...(dto.recipientName !== undefined ? { recipientName: dto.recipientName.trim() } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone.replace(/ /g, '') } : {}),
        ...(dto.addressLine !== undefined ? { addressLine: dto.addressLine.trim() } : {}),
        ...(dto.city !== undefined ? { city: dto.city.trim() } : {}),
        ...(dto.province !== undefined ? { province: dto.province?.trim() || null } : {}),
        ...(dto.postalCode !== undefined ? { postalCode: dto.postalCode } : {}),
      },
      select: ADDRESS_SELECT,
    });
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
  async setDefaultAddress(userId: string, id: string): Promise<AddressRow> {
    const existing = await this.assertOwner(userId, id);
    return this.prisma.$transaction(async (tx) => {
      await tx.address.updateMany({ where: { userId, deletedAt: null, isDefault: true }, data: { isDefault: false } });
      return tx.address.update({ where: { id: existing.id }, data: { isDefault: true }, select: ADDRESS_SELECT });
    });
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
