import { Test, TestingModule } from '@nestjs/testing';
import { AddressesService } from '../addresses.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AddressLabel } from '@prisma/client';

const mockPrisma: Record<string, any> = {
  address: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(mockPrisma)),
};

const baseDto = {
  label: AddressLabel.RUMAH,
  recipientName: 'Budi',
  phone: '08123456789',
  addressLine: 'Jl. Mawar No. 1',
  city: 'Jakarta',
  postalCode: '12345',
};

describe('AddressesService', () => {
  let service: AddressesService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockPrisma));
    const module: TestingModule = await Test.createTestingModule({
      providers: [AddressesService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = module.get<AddressesService>(AddressesService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('createAddress', () => {
    it('alamat pertama otomatis jadi default', async () => {
      mockPrisma.address.count.mockResolvedValue(0);
      mockPrisma.address.create.mockResolvedValue({ id: 'a1', isDefault: true });
      const result = await service.createAddress('user-1', baseDto as never);
      expect(result.isDefault).toBe(true);
      expect(mockPrisma.address.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isDefault: true }) }),
      );
    });

    it('menolak label LAINNYA tanpa customLabel', async () => {
      await expect(
        service.createAddress('user-1', { ...baseDto, label: AddressLabel.LAINNYA } as never),
      ).rejects.toThrow('Label custom wajib diisi');
    });

    it('menolak kode pos bukan 5 digit di level service? (validasi DTO) — service menolak >20 alamat', async () => {
      mockPrisma.address.count.mockResolvedValue(20);
      await expect(service.createAddress('user-1', baseDto as never)).rejects.toThrow('Maksimal 20 alamat');
    });
  });

  describe('setDefaultAddress', () => {
    it('me-reset default lain dalam transaksi', async () => {
      mockPrisma.address.findFirst.mockResolvedValue({ id: 'a2', label: AddressLabel.KANTOR });
      mockPrisma.address.update.mockResolvedValue({ id: 'a2', isDefault: true });
      const result = await service.setDefaultAddress('user-1', 'a2');
      expect(mockPrisma.address.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isDefault: false } }),
      );
      expect(result.isDefault).toBe(true);
    });

    it('404 untuk alamat milik orang lain', async () => {
      mockPrisma.address.findFirst.mockResolvedValue(null);
      await expect(service.setDefaultAddress('user-1', 'nope')).rejects.toThrow('Alamat tidak ditemukan');
    });
  });

  describe('deleteAddress', () => {
    it('mempromosikan alamat lain bila yang dihapus adalah default', async () => {
      mockPrisma.address.findFirst
        .mockResolvedValueOnce({ id: 'a1', isDefault: true })
        .mockResolvedValueOnce({ id: 'a2' });
      await service.deleteAddress('user-1', 'a1');
      expect(mockPrisma.address.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'a2' }, data: { isDefault: true } }),
      );
    });
  });
});
