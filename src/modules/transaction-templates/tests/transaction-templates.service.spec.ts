import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { TransactionTemplatesService } from '../transaction-templates.service';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrisma = {
  transactionTemplate: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('TransactionTemplatesService', () => {
  let service: TransactionTemplatesService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionTemplatesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<TransactionTemplatesService>(TransactionTemplatesService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('getMyTemplates', () => {
    it('returns user templates ordered by default+lastUsed+createdAt', async () => {
      mockPrisma.transactionTemplate.findMany.mockResolvedValue([{
        id: 't1', name: 'X', title: 'Title', description: '', orderType: 'GOODS',
        orderValue: BigInt(10000000), feeResponsibility: 'BUYER', deliveryDeadlineDays: 3,
        isDefault: true, usageCount: 5, lastUsedAt: new Date(), createdAt: new Date(),
      }]);
      const result = await service.getMyTemplates('u1');
      expect(result.total).toBe(1);
      expect(result.templates[0].orderValue).toBe(100000);
    });
  });

  describe('getTemplate', () => {
    it('returns template when owner matches', async () => {
      mockPrisma.transactionTemplate.findUnique.mockResolvedValue({
        id: 't1', userId: 'u1', name: 'X', title: 'T', description: '',
        orderType: 'GOODS', orderValue: BigInt(5000000), feeResponsibility: 'BUYER',
        deliveryDeadlineDays: 3, isDefault: false, usageCount: 0, lastUsedAt: null, createdAt: new Date(),
      });
      const result = await service.getTemplate('u1', 't1');
      expect((result as any).orderValue).toBe(50000);
    });

    it('throws NotFoundException when missing', async () => {
      mockPrisma.transactionTemplate.findUnique.mockResolvedValue(null);
      await expect(service.getTemplate('u1', 't1')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not owner', async () => {
      mockPrisma.transactionTemplate.findUnique.mockResolvedValue({ id: 't1', userId: 'other' });
      await expect(service.getTemplate('u1', 't1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('createTemplate', () => {
    it('creates template under limit', async () => {
      mockPrisma.transactionTemplate.count.mockResolvedValue(5);
      mockPrisma.transactionTemplate.create.mockResolvedValue({ id: 't1', name: 'X' });
      const result = await service.createTemplate('u1', { name: 'X', title: 'T', orderType: 'GOODS', orderValue: 50000 } as any);
      expect((result as any).id).toBe('t1');
      expect(mockPrisma.transactionTemplate.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ orderValue: BigInt(5000000), feeResponsibility: 'BUYER', deliveryDeadlineDays: 3 }),
      }));
    });

    it('throws BadRequestException at template limit (20)', async () => {
      mockPrisma.transactionTemplate.count.mockResolvedValue(20);
      await expect(service.createTemplate('u1', { name: 'X', title: 'T', orderType: 'GOODS', orderValue: 100 } as any))
        .rejects.toThrow(BadRequestException);
    });

    it('unsets other defaults when creating with isDefault=true', async () => {
      mockPrisma.transactionTemplate.count.mockResolvedValue(0);
      mockPrisma.transactionTemplate.create.mockResolvedValue({ id: 'tnew', name: 'X' });
      mockPrisma.transactionTemplate.updateMany.mockResolvedValue({ count: 1 });
      await service.createTemplate('u1', { name: 'X', title: 'T', orderType: 'GOODS', orderValue: 100, isDefault: true } as any);
      expect(mockPrisma.transactionTemplate.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ userId: 'u1' }),
        data: { isDefault: false },
      }));
    });
  });

  describe('updateTemplate', () => {
    it('updates owned template fields', async () => {
      mockPrisma.transactionTemplate.findUnique.mockResolvedValue({ id: 't1', userId: 'u1' });
      mockPrisma.transactionTemplate.update.mockResolvedValue({});
      const result = await service.updateTemplate('u1', 't1', { title: 'New' } as any);
      expect(result.message).toContain('updated');
    });

    it('converts orderValue to sen on update', async () => {
      mockPrisma.transactionTemplate.findUnique.mockResolvedValue({ id: 't1', userId: 'u1' });
      mockPrisma.transactionTemplate.update.mockResolvedValue({});
      await service.updateTemplate('u1', 't1', { orderValue: 100 } as any);
      expect(mockPrisma.transactionTemplate.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ orderValue: BigInt(10000) }),
      }));
    });

    it('throws ForbiddenException when not owner', async () => {
      mockPrisma.transactionTemplate.findUnique.mockResolvedValue({ id: 't1', userId: 'other' });
      await expect(service.updateTemplate('u1', 't1', {} as any)).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when missing', async () => {
      mockPrisma.transactionTemplate.findUnique.mockResolvedValue(null);
      await expect(service.updateTemplate('u1', 't1', {} as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteTemplate', () => {
    it('deletes owned template', async () => {
      mockPrisma.transactionTemplate.findUnique.mockResolvedValue({ id: 't1', userId: 'u1' });
      mockPrisma.transactionTemplate.delete.mockResolvedValue({});
      const result = await service.deleteTemplate('u1', 't1');
      expect(result.message).toContain('deleted');
    });

    it('throws ForbiddenException when not owner', async () => {
      mockPrisma.transactionTemplate.findUnique.mockResolvedValue({ id: 't1', userId: 'other' });
      await expect(service.deleteTemplate('u1', 't1')).rejects.toThrow(ForbiddenException);
    });
  });

  describe('recordUsage', () => {
    it('increments usage count and sets lastUsedAt', async () => {
      mockPrisma.transactionTemplate.update.mockResolvedValue({});
      await service.recordUsage('t1');
      expect(mockPrisma.transactionTemplate.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 't1' },
        data: expect.objectContaining({ usageCount: { increment: 1 } }),
      }));
    });
  });
});
