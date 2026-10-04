import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RealtimeGateway } from '../realtime.gateway';
import { RealtimeService } from '../realtime.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { SupportChatService } from '../../support/support-chat.service';

// POIN 5 (2026-10-04) — livechat support websocket penuh: handler support.*
// dan autentikasi ganda (token user ATAU token admin support) pada SATU gateway.

const USER_PAYLOAD = { sub: 'u1', jti: 'jti-u1', exp: Math.floor(Date.now() / 1000) + 3600 };
const ADMIN_PAYLOAD = { sub: 'a1', jti: 'jti-a1', iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 3600 };

const mockPrisma = {
  user: { findUnique: jest.fn() },
  adminUser: { findUnique: jest.fn() },
  supportConversation: { findUnique: jest.fn(), findMany: jest.fn() },
  chatRoom: { findMany: jest.fn().mockResolvedValue([]) },
  order: { findMany: jest.fn().mockResolvedValue([]) },
  notification: { count: jest.fn(), findFirst: jest.fn() },
  onNotificationCreated: jest.fn(),
};

const mockRedis = {
  incr: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(undefined),
  decr: jest.fn().mockResolvedValue(0),
  del: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
};
(mockRedis as any).incrWithTtl = (mockRedis as any).incr;

const mockRealtimeService = {
  setServer: jest.fn(),
  refreshUserPresence: jest.fn().mockResolvedValue(undefined),
  emitToUser: jest.fn(),
  emitSignedToRoom: jest.fn(),
  emitSignedToRoomExcept: jest.fn().mockResolvedValue(undefined),
  setUserPresence: jest.fn().mockResolvedValue(undefined),
  getConnectionCount: jest.fn().mockResolvedValue(0),
  isUserOnline: jest.fn().mockResolvedValue(true),
  isHmacEnabled: jest.fn().mockReturnValue(false),
  generateSessionKey: jest.fn().mockReturnValue('k'),
};

const mockSupportChat = {
  getConversationForUser: jest.fn(),
  getConversationForAdmin: jest.fn(),
  getMessages: jest.fn(),
  getQueuePosition: jest.fn(),
  sendUserMessage: jest.fn(),
  sendAgentMessage: jest.fn(),
};

const mockJwt = {
  verifyAsync: jest.fn(async (token: string, opts: { audience?: string }) => {
    if (token === 'user-token' && opts?.audience === 'kahade-api') return USER_PAYLOAD;
    if (token === 'admin-token' && opts?.audience === 'kahade-admin-api') return ADMIN_PAYLOAD;
    throw new Error('invalid token');
  }),
};

const mockConfig = {
  get: jest.fn((key: string) => {
    if (key === 'jwt.secret') return 'user-secret';
    if (key === 'jwt.adminSecret') return 'admin-secret';
    return null;
  }),
};

function makeSocket(token: string | null) {
  return {
    id: 'sock-1',
    handshake: { auth: { token }, headers: {}, query: {} },
    join: jest.fn().mockResolvedValue(undefined),
    leave: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    disconnect: jest.fn(),
    disconnected: false,
    rooms: new Set<string>(['sock-1']),
  };
}

const CONV_VIEW = {
  id: 'conv1', userId: 'u1', status: 'WAITING', assignedAgent: null,
};

describe('RealtimeGateway — support livechat (POIN 5)', () => {
  let gateway: RealtimeGateway;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ isActive: true, isBanned: false });
    mockPrisma.adminUser.findUnique.mockResolvedValue({
      isActive: true, deletedAt: null, lockedUntil: null, role: 'CUSTOMER_SUPPORT',
    });
    mockPrisma.supportConversation.findMany.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: RealtimeService, useValue: mockRealtimeService },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
        { provide: SupportChatService, useValue: mockSupportChat },
      ],
    }).compile();
    gateway = module.get<RealtimeGateway>(RealtimeGateway);
  });

  describe('handleConnection — autentikasi ganda', () => {
    it('menerima token admin support: role=admin, join admin:* + support:agents', async () => {
      const client = makeSocket('admin-token');
      await gateway.handleConnection(client as never);

      expect((client as any).role).toBe('admin');
      expect((client as any).adminId).toBe('a1');
      expect(client.join).toHaveBeenCalledWith('admin:a1');
      expect(client.join).toHaveBeenCalledWith('support:agents');
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(mockRealtimeService.setUserPresence).toHaveBeenCalledWith('a1', true);
    });

    it('menolak token admin yang role-nya bukan support', async () => {
      mockPrisma.adminUser.findUnique.mockResolvedValueOnce({
        isActive: true, deletedAt: null, lockedUntil: null, role: 'FINANCE_ADMIN',
      });
      const client = makeSocket('admin-token');
      await gateway.handleConnection(client as never);
      expect(client.emit).toHaveBeenCalledWith('error', expect.objectContaining({ message: 'Authentication failed' }));
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('jalur user tetap seperti semula (tanpa admin)', async () => {
      const client = makeSocket('user-token');
      await gateway.handleConnection(client as never);
      expect((client as any).role).toBe('user');
      expect((client as any).userId).toBe('u1');
      expect(client.join).toHaveBeenCalledWith('user:u1');
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('token sampah ditolak', async () => {
      const client = makeSocket('garbage');
      await gateway.handleConnection(client as never);
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });
  });

  describe('support.join', () => {
    function arrangeUserConv() {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ id: 'conv1', userId: 'u1' });
      mockSupportChat.getConversationForUser.mockResolvedValue(CONV_VIEW);
      mockSupportChat.getMessages.mockResolvedValue({ data: [{ id: 'm1' }], nextCursor: null });
      mockSupportChat.getQueuePosition.mockResolvedValue(2);
    }

    it('menolak user yang bukan pemilik percakapan', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ id: 'conv1', userId: 'u-lain' });
      const client = { ...makeSocket('user-token'), userId: 'u1', role: 'user' as const };
      const res = await gateway.handleSupportJoin(client as never, { conversationId: 'conv1' });
      expect(res.success).toBe(false);
      expect(client.join).not.toHaveBeenCalledWith('support:conv1');
    });

    it('user pemilik: join room + terima riwayat + posisi antrean', async () => {
      arrangeUserConv();
      const client = { ...makeSocket('user-token'), userId: 'u1', role: 'user' as const };
      const res = await gateway.handleSupportJoin(client as never, { conversationId: 'conv1' });
      expect(res.success).toBe(true);
      expect(client.join).toHaveBeenCalledWith('support:conv1');
      expect(res.messages).toEqual([{ id: 'm1' }]);
      expect(res.queuePosition).toBe(2);
      expect(mockRealtimeService.emitSignedToRoomExcept).toHaveBeenCalledWith(
        'support:conv1', 'sock-1', 'support.user_joined', expect.objectContaining({ userId: 'u1' }),
      );
      // dilacak untuk event leave saat disconnect
      expect((client as any)._supportRooms.has('support:conv1')).toBe(true);
    });

    it('admin boleh join percakapan apapun (role support)', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ id: 'conv1', userId: 'u1' });
      mockSupportChat.getConversationForAdmin.mockResolvedValue({ ...CONV_VIEW, assignedAgent: { id: 'a1', name: 'Siti' } });
      mockSupportChat.getMessages.mockResolvedValue({ data: [], nextCursor: null });
      const client = { ...makeSocket('admin-token'), adminId: 'a1', role: 'admin' as const };
      const res = await gateway.handleSupportJoin(client as never, { conversationId: 'conv1' });
      expect(res.success).toBe(true);
      expect(mockRealtimeService.emitSignedToRoomExcept).toHaveBeenCalledWith(
        'support:conv1', 'sock-1', 'support.agent_joined', expect.objectContaining({ agentId: 'a1' }),
      );
    });
  });

  describe('support.message', () => {
    it('user → sendUserMessage, ack berisi pesan tersimpan', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ id: 'conv1', userId: 'u1' });
      mockSupportChat.sendUserMessage.mockResolvedValue({ id: 'm9', senderType: 'USER' });
      const client = { ...makeSocket('user-token'), userId: 'u1', role: 'user' as const };
      const res = await gateway.handleSupportMessage(client as never, { conversationId: 'conv1', content: 'halo' });
      expect(res.success).toBe(true);
      expect(mockSupportChat.sendUserMessage).toHaveBeenCalledWith('u1', 'conv1', 'halo', undefined);
      expect(res.data).toEqual({ id: 'm9', senderType: 'USER' });
    });

    it('admin → sendAgentMessage', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ id: 'conv1', userId: 'u1' });
      mockSupportChat.sendAgentMessage.mockResolvedValue({ id: 'm10', senderType: 'AGENT' });
      const client = { ...makeSocket('admin-token'), adminId: 'a1', role: 'admin' as const };
      const res = await gateway.handleSupportMessage(client as never, { conversationId: 'conv1', content: 'Halo' });
      expect(res.success).toBe(true);
      expect(mockSupportChat.sendAgentMessage).toHaveBeenCalledWith('a1', 'conv1', 'Halo', undefined);
    });

    it('error service → ack gagal tanpa throw', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ id: 'conv1', userId: 'u1' });
      mockSupportChat.sendUserMessage.mockRejectedValue(new Error('boom'));
      const client = { ...makeSocket('user-token'), userId: 'u1', role: 'user' as const };
      const res = await gateway.handleSupportMessage(client as never, { conversationId: 'conv1', content: 'halo' });
      expect(res.success).toBe(false);
    });
  });

  describe('support.typing', () => {
    it('broadcast support.typing ke room kecuali pengirim', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue({ id: 'conv1', userId: 'u1' });
      const client = { ...makeSocket('user-token'), userId: 'u1', role: 'user' as const };
      await gateway.handleSupportTyping(client as never, { conversationId: 'conv1', isTyping: true });
      expect(mockRealtimeService.emitSignedToRoomExcept).toHaveBeenCalledWith(
        'support:conv1',
        'sock-1',
        'support.typing',
        expect.objectContaining({ conversationId: 'conv1', senderType: 'USER', senderId: 'u1', isTyping: true }),
      );
    });

    it('tanpa akses → tidak broadcast', async () => {
      mockPrisma.supportConversation.findUnique.mockResolvedValue(null);
      const client = { ...makeSocket('user-token'), userId: 'u1', role: 'user' as const };
      await gateway.handleSupportTyping(client as never, { conversationId: 'nope', isTyping: true });
      expect(mockRealtimeService.emitSignedToRoomExcept).not.toHaveBeenCalled();
    });
  });

  describe('handleDisconnect — event leave support', () => {
    it('mengirim support.agent_left ke room yang pernah di-join', async () => {
      const client = {
        ...makeSocket('admin-token'),
        adminId: 'a1',
        role: 'admin' as const,
        _supportRooms: new Set(['support:conv1']),
        _connectionLeaseRegistered: false,
        _presenceRegistered: false,
      };
      await gateway.handleDisconnect(client as never);
      expect(mockRealtimeService.emitSignedToRoomExcept).toHaveBeenCalledWith(
        'support:conv1', 'sock-1', 'support.agent_left', expect.objectContaining({ agentId: 'a1' }),
      );
      expect((client as any)._supportRooms.size).toBe(0);
    });
  });
});
