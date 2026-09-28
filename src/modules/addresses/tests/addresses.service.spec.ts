import { Test, TestingModule } from '@nestjs/testing';
import { AddressesService } from '../addresses.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AddressLabel } from '@prisma/client';
import { initializeCrypto } from '../../../common/utils/crypto.util';

initializeCrypto({ aesSecretKey: 'test-aes-secret-h2', hmacSecretKey: 'test-hmac-secret-h2' });

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

  describe('H2: enkripsi PII saat rest', () => {
    it('createAddress menyimpan ciphertext (bukan plaintext)', async () => {
      mockPrisma.address.count.mockResolvedValue(0);
      mockPrisma.address.create.mockImplementation(async ({ data }: any) => ({ id: 'a1', ...data }));
      const result = await service.createAddress('user-1', baseDto as never);
      const saved = mockPrisma.address.create.mock.calls[0][0].data;
      for (const f of ['recipientName', 'phone', 'addressLine', 'city', 'postalCode'] as const) {
        expect(saved[f]).toMatch(/^v1:/);
        expect(saved[f]).not.toContain(baseDto[f]);
      }
      // Response ke pemanggil tetap plaintext (terdekripsi).
      expect(result.recipientName).toBe('Budi');
      expect(result.phone).toBe('08123456789');
      expect(result.city).toBe('Jakarta');
    });

    it('getAddress mendekripsi ciphertext', async () => {
      mockPrisma.address.count.mockResolvedValue(0);
      mockPrisma.address.create.mockImplementation(async ({ data }: any) => ({ id: 'a1', ...data }));
      await service.createAddress('user-1', baseDto as never);
      const saved = mockPrisma.address.create.mock.calls[0][0].data;
      mockPrisma.address.findFirst.mockResolvedValue({ id: 'a1', ...saved });
      const got = await service.getAddress('user-1', 'a1');
      expect(got.recipientName).toBe('Budi');
      expect(got.addressLine).toBe('Jl. Mawar No. 1');
    });

    it('baca dua arah: legacy plaintext tetap terbaca (fallback pra-backfill)', async () => {
      mockPrisma.address.findFirst.mockResolvedValue({
        id: 'a9',
        recipientName: 'Siti',
        phone: '0811111111',
        addressLine: 'Jl. Kenanga 2',
        city: 'Bandung',
        province: null,
        postalCode: '40111',
      });
      const got = await service.getAddress('user-1', 'a9');
      expect(got.recipientName).toBe('Siti');
      expect(got.province).toBeNull();
    });

    it('updateAddress mengenkripsi field yang diubah', async () => {
      mockPrisma.address.findFirst.mockResolvedValue({ id: 'a1', label: AddressLabel.RUMAH, customLabel: null });
      mockPrisma.address.update.mockImplementation(async ({ data }: any) => ({ id: 'a1', ...data }));
      await service.updateAddress('user-1', 'a1', { city: 'Surabaya' } as never);
      const saved = mockPrisma.address.update.mock.calls[0][0].data;
      expect(saved.city).toMatch(/^v1:/);
      expect(saved.city).not.toContain('Surabaya');
    });
  });
});
