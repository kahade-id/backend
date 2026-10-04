import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SupportChatService } from '../support-chat.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { RedisService } from '../../../redis/redis.service';
import { UploadService } from '../../upload/upload.service';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { SubscriptionsService } from '../../subscriptions/subscriptions.service';

// POIN 5 (2026-10-04) — livechat support websocket penuh.
// AGENTS.md (quirk jest+Prisma): nilai enum BARU sebagai literal string.

const mockPrisma = {
  supportConversation: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  supportMessage: { create: jest.fn(), findMany: jest.fn() },
  supportTicket: { create: jest.fn() },
  adminUser: { findUnique: jest.fn(), findMany: jest.fn() },
  notification: { create: jest.fn() },
  $transaction: jest.fn(),
  emitNotificationCreated: jest.fn(),
};

const mockRealtime = {
  emitToSupportRoom: jest.fn(),
  emitToUser: jest.fn(),
  emitToAdmin: jest.fn(),
  emitToSupportAgents: jest.fn(),
  areUsersOnline: jest.fn().mockResolvedValue({}),
  isUserOnline: jest.fn().mockResolvedValue(false),
};

const mockRedis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() };
const mockUpload = { verifyUserFileKeys: jest.fn().mockResolvedValue(undefined) };
const mockAuditLog = { logAdminAction: jest.fn() };
const mockSubscriptions = { isActive: jest.fn().mockResolvedValue(false) };

const CONV = {
  id: 'conv1',
  userId: 'u1',
  status: 'WAITING',
  assignedAgentId: null,
  assignedAt: null,
  priority: false,
  rating: null,
  assignedAgent: null,
};

function convView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv1',
    userId: 'u1',
    user: null,
    status: 'WAITING',
    subject: null,
    priority: false,
    source: 'APP',
    assignedAgent: null,
    closedAt: null,
    rating: null,
    createdAt: new Date('2026-10-04T10:00:00Z'),
    updatedAt: new Date('2026-10-04T10:00:00Z'),
    ...overrides,
  };
}

describe('SupportChatService (POIN 5)', () => {
  let service: SupportChatService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockSubscriptions.isActive.mockResolvedValue(false);
    mockUpload.verifyUserFileKeys.mockResolvedValue(undefined);
    mockRealtime.areUsersOnline.mockResolvedValue({});
    mockRealtime.isUserOnline.mockResolvedValue(false);
    mockRedis.get.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockPrisma) => unknown) => cb(mockPrisma));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportChatService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RealtimeService, useValue: mockRealtime },
        { provide: RedisService, useValue: mockRedis },
        { provide: UploadService, useValue: mockUpload },
        { provide: AuditLogService, useValue: mockAuditLog },
        { provide: SubscriptionsService, useValue: mockSubscriptions },
      ],
    }).compile();
    service = module.get<SupportChatService>(SupportChatService);
  });

  describe('getOrCreateConversation', () => {
    it('mengembalikan percakapan aktif yang sudah ada (idempoten, tanpa create)', async () => {
      mockPrisma.supportConversation.findFirst.mockResolvedValue({ ...CONV, assignedAgent: null });
      const { conversation, created } = await service.getOrCreateConversation('u1');
      expect(created).toBe(false);
      expect((conversation as any).id).toBe('conv1');
      expect(mockPrisma.supportConversation.create).not.toHaveBeenCalled();
    });

    it('membuat percakapan WAITING baru dengan priority Kahade+', async () => {
      mockPrisma.supportConversation.findFirst.mockResolvedValue(null);
      mockSubscriptions.isActive.mockResolvedValueOnce(true);
      mockPrisma.supportConversation.create.mockResolvedValue({ ...CONV, priority: true, assignedAgent: null });
      mockPrisma.supportMessage.create.mockResolvedValue({ id: 'm0' });
      const { conversation, created } = await service.getOrCreateConversation('u1', 'HELP_SITE', 'Topik');
      expect(created).toBe(true);
      expect(mockPrisma.supportConversation.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'WAITING', source: 'HELP_SITE', priority: true }) }),
      );
      expect(mockRealtime.emitToSupportAgents).toHaveBeenCalledWith(
        'support.queue.changed',
        expect.objectContaining({ change: 'created' }),
      );
      expect((conversation as any).priority).toBe(true);
    });
  });

  describe('sendUserMessage', () => {
    it('menolak pesan ke percakapan CLOSED', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ ...CONV, status: 'CLOSED' });
      await expect(service.sendUserMessage('u1', 'conv1', 'halo', [])).rejects.toThrow(BadRequestException);
    });

    it('menolak pesan dari user lain', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ ...CONV, userId: 'u-lain' });
      await expect(service.sendUserMessage('u1', 'conv1', 'halo', [])).rejects.toThrow(ForbiddenException);
    });

    it('menyimpan + broadcast ke room dan ke agen yang menangani', async () => {
      const assigned = { ...CONV, status: 'OPEN', assignedAgentId: 'a1' };
      mockPrisma.supportConversation.findUnique.mockResolvedValue(assigned);
      mockPrisma.supportConversation.update.mockResolvedValue(assigned);
      mockPrisma.supportMessage.create.mockResolvedValue({
        id: 'm1', conversationId: 'conv1', senderType: 'USER', senderUserId: 'u1', senderAdminId: null,
        senderUser: { id: 'u1', username: 'budi', fullName: 'Budi' }, senderAdmin: null,
        content: 'halo', attachments: [], createdAt: new Date(),
      });
      const view = await service.sendUserMessage('u1', 'conv1', 'halo', []);
      expect(view.senderType).toBe('USER');
      expect(mockUpload.verifyUserFileKeys).toHaveBeenCalledWith('u1', [], 'CHAT_ATTACHMENT', expect.anything());
      expect(mockRealtime.emitToSupportRoom).toHaveBeenCalledWith('conv1', 'support.message.new', expect.objectContaining({ id: 'm1' }));
      expect(mockRealtime.emitToAdmin).toHaveBeenCalledWith('a1', 'support.message.new', expect.anything());
      // Pesan user TIDAK membuat notifikasi in-app (hanya balasan agen).
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });
  });

  describe('sendAgentMessage', () => {
    it('auto-claim: WAITING → OPEN + assignedAgentId terisi + notifikasi ke user', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ ...CONV, status: 'WAITING', assignedAgentId: null });
      mockPrisma.supportMessage.create.mockResolvedValue({
        id: 'm2', conversationId: 'conv1', senderType: 'AGENT', senderUserId: null, senderAdminId: 'a1',
        senderUser: null, senderAdmin: { id: 'a1', fullName: 'Siti' },
        content: 'Halo, ada yang bisa dibantu?', attachments: [], createdAt: new Date(),
      });
      mockPrisma.supportConversation.update.mockResolvedValue({ ...CONV, status: 'OPEN', assignedAgentId: 'a1' });
      mockPrisma.adminUser.findUnique.mockResolvedValue({ fullName: 'Siti' });
      mockPrisma.notification.create.mockResolvedValue({ notifId: 'NTF-1' });

      const view = await service.sendAgentMessage('a1', 'conv1', 'Halo, ada yang bisa dibantu?', []);
      expect(view.senderType).toBe('AGENT');
      expect(view.senderName).toBe('Siti');
      // Transaksi meng-update status → OPEN dan assignedAgentId → a1.
      const txUpdate = mockPrisma.supportConversation.update.mock.calls[0][0];
      expect(txUpdate.data.status).toBe('OPEN');
      expect(txUpdate.data.assignedAgentId).toBe('a1');
      // Notifikasi in-app dibuat untuk user + event notification.new di-emit.
      expect(mockPrisma.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: 'u1', type: 'SUPPORT_AGENT_REPLY' }) }),
      );
      expect(mockPrisma.emitNotificationCreated).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', data: expect.objectContaining({ type: 'SUPPORT_CHAT_REPLY', conversationId: 'conv1' }) }),
      );
      expect(mockRealtime.emitToUser).toHaveBeenCalledWith('u1', 'support.message.new', expect.anything());
    });
  });

  describe('claimConversation', () => {
    it('agen biasa tidak bisa assign ke agen lain', async () => {
      await expect(
        service.claimConversation('a1', 'CUSTOMER_SUPPORT' as never, 'conv1', 'a2'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('claim WAITING → ASSIGNED + pesan sistem + audit', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue({ id: 'a1', fullName: 'Siti', role: 'CUSTOMER_SUPPORT', isActive: true, deletedAt: null });
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ ...CONV, status: 'WAITING' });
      mockPrisma.supportConversation.update.mockResolvedValue({ ...convView(), status: 'ASSIGNED', assignedAgent: { id: 'a1', fullName: 'Siti' } });
      mockPrisma.supportMessage.create.mockResolvedValue({ id: 'ms' });
      const result = await service.claimConversation('a1', 'CUSTOMER_SUPPORT' as never, 'conv1');
      expect((result as any).status).toBe('ASSIGNED');
      expect(mockAuditLog.logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'SupportConversation' }));
      expect(mockRealtime.emitToSupportAgents).toHaveBeenCalledWith('support.queue.changed', expect.objectContaining({ status: 'ASSIGNED' }));
    });

    it('menolak claim percakapan yang sudah CLOSED', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValue({ id: 'a1', fullName: 'Siti', role: 'CUSTOMER_SUPPORT', isActive: true, deletedAt: null });
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ ...CONV, status: 'CLOSED' });
      await expect(service.claimConversation('a1', 'CUSTOMER_SUPPORT' as never, 'conv1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('closeConversation', () => {
    it('user tidak bisa menutup percakapan milik orang lain', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ ...CONV, userId: 'u-lain' });
      await expect(service.closeConversation('conv1', 'USER' as never, 'u1')).rejects.toThrow(ForbiddenException);
    });

    it('agen menutup → CLOSED + pesan sistem', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ ...CONV, status: 'OPEN' });
      mockPrisma.supportConversation.update.mockResolvedValue({ ...convView(), status: 'CLOSED' });
      mockPrisma.supportMessage.create.mockResolvedValue({ id: 'ms' });
      const result = await service.closeConversation('conv1', 'AGENT' as never, 'a1');
      expect((result as any).status).toBe('CLOSED');
      expect(mockRealtime.emitToSupportAgents).toHaveBeenCalledWith('support.queue.changed', expect.objectContaining({ status: 'CLOSED' }));
    });
  });

  describe('escalateToTicket', () => {
    it('membuat tiket CHAT_ESCALATION beserta transkrip + audit', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({
        ...CONV,
        status: 'OPEN',
        assignedAgentId: 'a1',
        assignedAgent: { fullName: 'Siti' },
        messages: [
          { senderType: 'USER', senderUser: { fullName: 'Budi', username: 'budi' }, senderAdmin: null, content: 'Dana saya belum masuk', attachments: [], createdAt: new Date('2026-10-04T10:01:00Z') },
          { senderType: 'AGENT', senderUser: null, senderAdmin: { fullName: 'Siti' }, content: 'Kami cek dulu ya', attachments: [], createdAt: new Date('2026-10-04T10:02:00Z') },
          { senderType: 'SYSTEM', senderUser: null, senderAdmin: null, content: 'Percakapan dibuat.', attachments: [], createdAt: new Date('2026-10-04T10:00:00Z') },
        ],
      });
      mockPrisma.supportTicket.create.mockResolvedValue({ id: 'tkt1' });
      mockPrisma.supportMessage.create.mockResolvedValue({ id: 'ms' });

      const ticket = await service.escalateToTicket('a1', 'conv1', { subject: 'Dana belum masuk', category: 'PAYMENT' }, '127.0.0.1');
      expect((ticket as any).id).toBe('tkt1');
      const data = mockPrisma.supportTicket.create.mock.calls[0][0].data;
      expect(data.sourceType).toBe('CHAT_ESCALATION');
      expect(data.sourceChatRoomId).toBe('conv1');
      expect(data.category).toBe('PAYMENT');
      expect(data.status).toBe('OPEN');
      expect(data.transcriptText).toContain('User (Budi): Dana saya belum masuk');
      expect(data.transcriptText).toContain('Agen (Siti): Kami cek dulu ya');
      expect(mockAuditLog.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: 'SupportTicket', description: expect.stringContaining('conv1') }),
      );
      expect(mockRealtime.emitToUser).toHaveBeenCalledWith('u1', 'support.escalated', expect.objectContaining({ ticketId: 'tkt1' }));
    });

    it('subject wajib', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ ...CONV, messages: [], assignedAgent: null });
      await expect(service.escalateToTicket('a1', 'conv1', { subject: '   ' }, '')).rejects.toThrow(BadRequestException);
    });
  });

  describe('rateConversation', () => {
    it('menolak rating sebelum CLOSED', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ ...CONV, status: 'OPEN' });
      await expect(service.rateConversation('u1', 'conv1', 5)).rejects.toThrow(BadRequestException);
    });

    it('menolak rating ganda', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ ...CONV, status: 'CLOSED', rating: 5 });
      await expect(service.rateConversation('u1', 'conv1', 4)).rejects.toThrow(BadRequestException);
    });
  });

  describe('getQueuePosition', () => {
    it('menghitung posisi antrean: prioritas didahulukan lalu FIFO', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ status: 'WAITING', priority: false, createdAt: new Date('2026-10-04T10:05:00Z') });
      mockPrisma.supportConversation.count.mockResolvedValue(2); // 1 prioritas + 1 non-prioritas lebih dulu
      expect(await service.getQueuePosition('conv1')).toBe(3);
      const where = mockPrisma.supportConversation.count.mock.calls[0][0].where;
      expect(where.status).toBe('WAITING');
    });

    it('null bila percakapan tidak WAITING', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ status: 'OPEN', priority: false, createdAt: new Date() });
      expect(await service.getQueuePosition('conv1')).toBeNull();
    });
  });

  describe('setAgentAvailability', () => {
    it('menyimpan flag available di Redis dengan TTL', async () => {
      const result = await service.setAgentAvailability('a1', true);
      expect(result).toEqual({ adminId: 'a1', available: true });
      expect(mockRedis.set).toHaveBeenCalledWith('support:agent:available:a1', '1', expect.any(Number));
    });

    it('menghapus flag saat unavailable', async () => {
      await service.setAgentAvailability('a1', false);
      expect(mockRedis.del).toHaveBeenCalledWith('support:agent:available:a1');
    });
  });
});
