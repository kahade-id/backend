import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionsService } from '../sessions.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';

const mockPrisma = {
  userSession: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  $transaction: jest.fn(),
};

const mockRedis = { setex: jest.fn().mockResolvedValue('OK') };
const mockConfig = { get: jest.fn().mockReturnValue('15m') };

describe('SessionsService', () => {
  let service: SessionsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockRedis.setex.mockResolvedValue('OK');
    mockConfig.get.mockReturnValue('15m');
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<SessionsService>(SessionsService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('getActiveSessions', () => {
    it('returns active sessions with masked IPv4', async () => {
      mockPrisma.userSession.findMany.mockResolvedValue([
        { id: 's1', deviceInfo: 'Chrome', ipAddress: '192.168.1.100', lastActiveAt: new Date(), createdAt: new Date() },
      ]);
      mockPrisma.userSession.count.mockResolvedValue(1);
      const result = await service.getActiveSessions('user-1', 's1');
      expect(result.sessions[0].ipAddress).toBe('192.168.***.***');
      expect(result.sessions[0].isCurrentSession).toBe(true);
    });

    it('masks IPv6 addresses', async () => {
      mockPrisma.userSession.findMany.mockResolvedValue([
        { id: 's2', deviceInfo: 'Safari', ipAddress: '2001:db8::1', lastActiveAt: new Date(), createdAt: new Date() },
      ]);
      mockPrisma.userSession.count.mockResolvedValue(1);
      const result = await service.getActiveSessions('user-1', 's1');
      expect(result.sessions[0].ipAddress).toContain('****');
    });

    it('returns null for null IP', async () => {
      mockPrisma.userSession.findMany.mockResolvedValue([
        { id: 's3', deviceInfo: 'X', ipAddress: null, lastActiveAt: new Date(), createdAt: new Date() },
      ]);
      mockPrisma.userSession.count.mockResolvedValue(1);
      const result = await service.getActiveSessions('user-1', 's1');
      expect(result.sessions[0].ipAddress).toBeNull();
    });

    it('respects pagination', async () => {
      mockPrisma.userSession.findMany.mockResolvedValue([]);
      mockPrisma.userSession.count.mockResolvedValue(0);
      await service.getActiveSessions('user-1', 's1', 2, 10);
      expect(mockPrisma.userSession.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
    });
  });

  describe('revokeSession', () => {
    it('revokes own session and sets redis flag', async () => {
      mockPrisma.userSession.findUnique.mockResolvedValue({ id: 's1', userId: 'user-1', isRevoked: false });
      mockPrisma.userSession.update.mockResolvedValue({});
      const result = await service.revokeSession('user-1', 's1');
      expect(result.message).toBe('Session revoked');
      expect(mockRedis.setex).toHaveBeenCalled();
    });

    it('throws NotFoundException when session missing', async () => {
      mockPrisma.userSession.findUnique.mockResolvedValue(null);
      await expect(service.revokeSession('user-1', 's1')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not owner', async () => {
      mockPrisma.userSession.findUnique.mockResolvedValue({ id: 's1', userId: 'other-user', isRevoked: false });
      await expect(service.revokeSession('user-1', 's1')).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when already revoked', async () => {
      mockPrisma.userSession.findUnique.mockResolvedValue({ id: 's1', userId: 'user-1', isRevoked: true });
      await expect(service.revokeSession('user-1', 's1')).rejects.toThrow(BadRequestException);
    });

    it('returns success when durable session revocation succeeds but Redis propagation fails', async () => {
      mockPrisma.userSession.findUnique.mockResolvedValue({ id: 's1', userId: 'user-1', isRevoked: false });
      mockPrisma.userSession.update.mockResolvedValue({});
      mockRedis.setex.mockRejectedValue(new Error('redis unavailable'));
      await expect(service.revokeSession('user-1', 's1')).resolves.toEqual({ message: 'Session revoked' });
      expect(mockRedis.setex).toHaveBeenCalledWith(expect.any(String), expect.any(Number), '1', { throwOnError: true });
    });
  });

  describe('revokeAllOtherSessions', () => {
    it('revokes all other sessions and returns count', async () => {
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 's2' }, { id: 's3' }]);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 2 });
      const result = await service.revokeAllOtherSessions('user-1', 's1');
      expect(result.count).toBe(2);
      expect(mockRedis.setex).toHaveBeenCalledTimes(2);
    });

    it('returns 0 when no other sessions', async () => {
      mockPrisma.userSession.findMany.mockResolvedValue([]);
      const result = await service.revokeAllOtherSessions('user-1', 's1');
      expect(result.count).toBe(0);
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });

    it('returns success when durable other-session revocation succeeds but Redis propagation fails', async () => {
      mockPrisma.userSession.findMany.mockResolvedValue([{ id: 's2' }]);
      mockPrisma.userSession.updateMany.mockResolvedValue({ count: 1 });
      mockRedis.setex.mockRejectedValue(new Error('redis unavailable'));
      await expect(service.revokeAllOtherSessions('user-1', 's1')).resolves.toEqual({ count: 1 });
    });
  });
});
