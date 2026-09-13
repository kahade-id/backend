import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AdminChatService } from '../admin-chat.service';
import { PrismaService } from '../../../../prisma/prisma.service';
import { AuditLogService } from '../../../../common/services/audit-log.service';

const mockPrisma = {
  chatModerationEvent: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    update: jest.fn(),
  },
};

const mockAuditLog = { logAdminAction: jest.fn() };

describe('AdminChatService — moderation queue', () => {
  let service: AdminChatService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminChatService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditLogService, useValue: mockAuditLog },
      ],
    }).compile();
    service = module.get<AdminChatService>(AdminChatService);
  });

  it('LISTS moderation events with pagination metadata', async () => {
    mockPrisma.chatModerationEvent.findMany.mockResolvedValue([{ id: 'cme-1' }]);
    mockPrisma.chatModerationEvent.count.mockResolvedValue(1);

    const result = (await service.listModerationEvents({ page: 1, limit: 20 })) as {
      data: unknown[];
      total: number;
    };

    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('REJECTS an unknown severity filter', async () => {
    await expect(service.listModerationEvents({ severity: 'APOCALYPTIC' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('RETURNS dashboard stats with zero-filled buckets', async () => {
    mockPrisma.chatModerationEvent.count.mockResolvedValue(3);
    mockPrisma.chatModerationEvent.groupBy.mockResolvedValue([
      { severity: 'CRITICAL', _count: { _all: 2 } },
    ]);

    const stats = (await service.getModerationStats()) as {
      pending: number;
      severity: Record<string, number>;
      action: Record<string, number>;
    };

    expect(stats.pending).toBe(3);
    expect(stats.severity.CRITICAL).toBe(2);
    // Bucket yang tidak ada di hasil groupBy tetap muncul dengan nilai 0.
    expect(stats.severity.LOW).toBe(0);
    expect(stats.action.BLOCKED).toBe(0);
  });

  it('THROWS NotFoundException for an unknown event', async () => {
    mockPrisma.chatModerationEvent.findFirst.mockResolvedValue(null);
    await expect(service.getModerationEventDetail('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('LOOKS UP an event by its public eventId as well as its cuid', async () => {
    mockPrisma.chatModerationEvent.findFirst.mockResolvedValue({
      id: 'cme-1',
      eventId: 'CME-20260913-001',
    });
    const event = (await service.getModerationEventDetail('CME-20260913-001')) as {
      eventId: string;
    };
    expect(mockPrisma.chatModerationEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ id: 'CME-20260913-001' }, { eventId: 'CME-20260913-001' }] },
      }),
    );
    expect(event.eventId).toBe('CME-20260913-001');
  });

  it('WRITES an audit log entry when an admin reviews an event', async () => {
    mockPrisma.chatModerationEvent.findFirst.mockResolvedValue({
      id: 'cme-1',
      eventId: 'CME-1',
      status: 'PENDING',
      action: 'BLOCKED',
    });
    mockPrisma.chatModerationEvent.update.mockResolvedValue({
      id: 'cme-1',
      eventId: 'CME-1',
      status: 'DISMISSED',
    });

    const result = await service.reviewModerationEvent(
      'CME-1',
      'admin-1',
      'DISMISSED',
      'false positive',
      '10.0.0.1',
    );

    expect(result).toMatchObject({ status: 'DISMISSED' });
    expect(mockAuditLog.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adminId: 'admin-1',
        targetType: 'ChatModerationEvent',
        targetId: 'CME-1',
        before: { status: 'PENDING' },
        after: { status: 'DISMISSED', note: 'false positive' },
      }),
    );
  });

  it('COUNTS repeated circumvention attempts per user', async () => {
    mockPrisma.chatModerationEvent.findMany.mockResolvedValue([
      {
        id: '1',
        eventId: 'CME-1',
        kind: 'CIRCUMVENTION',
        severity: 'HIGH',
        action: 'BLOCKED',
        status: 'PENDING',
        createdAt: new Date(),
        roomId: 'r1',
      },
      {
        id: '2',
        eventId: 'CME-2',
        kind: 'CIRCUMVENTION',
        severity: 'CRITICAL',
        action: 'BLOCKED',
        status: 'PENDING',
        createdAt: new Date(),
        roomId: 'r1',
      },
      {
        id: '3',
        eventId: 'CME-3',
        kind: 'PROFANITY',
        severity: 'MEDIUM',
        action: 'REDACTED',
        status: 'PENDING',
        createdAt: new Date(),
        roomId: 'r2',
      },
    ]);

    const result = (await service.listUserModerationEvents('user-1')) as {
      total: number;
      circumventionCount: number;
    };

    expect(result.total).toBe(3);
    expect(result.circumventionCount).toBe(2);
  });
});
