import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminBadgesService } from '../badges/admin-badges.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { NotificationQueueService } from '../../queue/notification-queue.service';

const mockPrisma = {
  badge: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  user: { findUnique: jest.fn() },
  userBadge: { findUnique: jest.fn(), create: jest.fn(), count: jest.fn(), delete: jest.fn() },
  $transaction: jest.fn(),
};
const mockAudit = { logAdminAction: jest.fn() };
const mockQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };

describe('AdminBadgesService', () => {
  let service: AdminBadgesService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockQueue.enqueue.mockResolvedValue(undefined);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminBadgesService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditLogService, useValue: mockAudit },
        { provide: NotificationQueueService, useValue: mockQueue },
      ],
    }).compile();
    service = module.get<AdminBadgesService>(AdminBadgesService);
  });

  it('rejects deletion of a badge with existing awards', async () => {
    mockPrisma.badge.findUnique.mockResolvedValue({ id: 'badge-1', name: 'Early adopter' });
    mockPrisma.userBadge.count.mockResolvedValue(2);

    await expect(service.deleteBadge('badge-1', 'admin-1', '127.0.0.1')).rejects.toMatchObject({
      response: { code: 'BADGE_HAS_AWARDS' },
    });
    expect(mockPrisma.badge.delete).not.toHaveBeenCalled();
  });

  it('deletes an unawarded badge atomically and records the admin action', async () => {
    mockPrisma.badge.findUnique.mockResolvedValue({ id: 'badge-1', name: 'Early adopter' });
    mockPrisma.userBadge.count.mockResolvedValue(0);
    mockPrisma.badge.delete.mockResolvedValue({ id: 'badge-1' });

    await expect(service.deleteBadge('badge-1', 'admin-1', '127.0.0.1')).resolves.toEqual({ message: 'Badge deleted successfully' });
    expect(mockPrisma.badge.delete).toHaveBeenCalledWith({ where: { id: 'badge-1' } });
    expect(mockAudit.logAdminAction).toHaveBeenCalled();
  });

  it('maps concurrent UserBadge unique races to BADGE_ALREADY_AWARDED', async () => {
    mockPrisma.badge.findUnique.mockResolvedValue({ id: 'badge-1', name: 'Early adopter' });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
    mockPrisma.userBadge.findUnique.mockResolvedValue(null);
    mockPrisma.userBadge.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' }));

    await expect(service.awardBadge('badge-1', 'user-1', 'admin-1', '127.0.0.1')).rejects.toMatchObject({
      response: { code: 'BADGE_ALREADY_AWARDED' },
    });
    await expect(service.awardBadge('badge-1', 'user-1', 'admin-1', '127.0.0.1')).rejects.toBeInstanceOf(ConflictException);
    expect(mockAudit.logAdminAction).not.toHaveBeenCalled();
    expect(mockQueue.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['createBadge', () => service.createBadge('admin-1', { name: 'Duplicate', iconUrl: 'https://cdn.example/badge.png' }, '127.0.0.1'), () => mockPrisma.badge.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' }))],
    ['updateBadge', () => service.updateBadge('badge-1', { name: 'Duplicate' }, 'admin-1', '127.0.0.1'), () => { mockPrisma.badge.findUnique.mockResolvedValue({ id: 'badge-1', name: 'Original' }); mockPrisma.badge.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' })); }],
  ])('maps duplicate badge names on %s to BADGE_NAME_TAKEN', async (_operation, call, setup) => {
    setup();

    await expect(call()).rejects.toMatchObject({ response: { code: 'BADGE_NAME_TAKEN' } });
  });
});
