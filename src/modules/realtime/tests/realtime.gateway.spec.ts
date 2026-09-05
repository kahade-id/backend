import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RealtimeGateway } from '../realtime.gateway';
import { RealtimeService } from '../realtime.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';

/*
 * D-02 regression: `join-room` joins `order:${chatRoom.order.orderId}` (the public order id),
 * but `leave-room` left `order:${chatRoom.orderId}` — the relation FK, which holds the internal
 * cuid (`schema.prisma:1223`). `socket.leave` on a room that was never joined is a silent no-op,
 * so closing a chat screen never unsubscribed the client: every room the user had visited kept
 * pushing `chat.new_message` down the socket for the rest of its life.
 *
 * The fixtures give `ChatRoom.id`, `ChatRoom.orderId` and `Order.orderId` three DISTINCT values,
 * which is what makes the join/leave asymmetry observable.
 */

const ROOM_ID = 'ckchatroom0001';
const ORDER_CUID = 'ckorderinternal01';
const ORDER_PUBLIC_ID = 'ORD-2026-0042';

const mockPrisma = {
  chatRoom: { findUnique: jest.fn() },
  order: { findFirst: jest.fn(), findMany: jest.fn() },
  notification: { count: jest.fn() },
  onNotificationCreated: jest.fn(),
};
const mockRedis = {
  incr: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(undefined),
  decr: jest.fn().mockResolvedValue(0),
  del: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue(null),
};
const mockRealtimeService = {
  setServer: jest.fn(),
  refreshUserPresence: jest.fn().mockResolvedValue(undefined),
  emitToUser: jest.fn(),
  emitSignedToRoom: jest.fn(),
  emitSignedToRoomExcept: jest.fn(),
  setUserPresence: jest.fn(),
  getConnectionCount: jest.fn().mockResolvedValue(0),
  isHmacEnabled: jest.fn().mockReturnValue(false),
  generateSessionKey: jest.fn().mockReturnValue('k'),
};

function makeClient(userId: string) {
  return {
    id: 'socket-1',
    userId,
    join: jest.fn().mockResolvedValue(undefined),
    leave: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

describe('RealtimeGateway — chat room join/leave symmetry (D-02)', () => {
  let gateway: RealtimeGateway;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.incr.mockResolvedValue(1);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: RealtimeService, useValue: mockRealtimeService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
      ],
    }).compile();
    gateway = module.get<RealtimeGateway>(RealtimeGateway);
  });

  function arrangeRoom() {
    mockPrisma.chatRoom.findUnique.mockResolvedValue({
      orderId: ORDER_CUID,
      order: { orderId: ORDER_PUBLIC_ID, buyerId: 'buyer', sellerId: 'seller' },
    });
  }

  it('leaves the SAME room name that join-room joined', async () => {
    arrangeRoom();
    const joinClient = makeClient('buyer');
    const leaveClient = makeClient('buyer');

    await gateway.handleJoinRoom(joinClient as never, { roomId: ROOM_ID });
    await gateway.handleLeaveRoom(leaveClient as never, { roomId: ROOM_ID });

    const joined = joinClient.join.mock.calls[0][0];
    const left = leaveClient.leave.mock.calls[0][0];
    expect(joined).toBe(`order:${ORDER_PUBLIC_ID}`);
    expect(left).toBe(joined);
  });

  it('never addresses the room by the internal cuid on leave', async () => {
    arrangeRoom();
    const client = makeClient('seller');

    await gateway.handleLeaveRoom(client as never, { roomId: ROOM_ID });

    // Pre-fix this was `order:ckorderinternal01` — a no-op leave.
    expect(client.leave).not.toHaveBeenCalledWith(`order:${ORDER_CUID}`);
    expect(client.leave).toHaveBeenCalledWith(`order:${ORDER_PUBLIC_ID}`);
  });

  it('still refuses a non-participant without leaving anything', async () => {
    arrangeRoom();
    const client = makeClient('attacker');

    const res = await gateway.handleLeaveRoom(client as never, { roomId: ROOM_ID });

    expect(res).toEqual({ success: false, message: 'Not a participant' });
    expect(client.leave).not.toHaveBeenCalled();
  });

  it('returns Room not found when the room has no order', async () => {
    mockPrisma.chatRoom.findUnique.mockResolvedValue(null);
    const client = makeClient('buyer');

    const res = await gateway.handleLeaveRoom(client as never, { roomId: ROOM_ID });

    expect(res).toEqual({ success: false, message: 'Room not found' });
    expect(client.leave).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway — multi-connection presence', () => {
  let gateway: RealtimeGateway;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.decr.mockResolvedValue(1);
    mockRealtimeService.getConnectionCount.mockResolvedValue(1);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: RealtimeService, useValue: mockRealtimeService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
      ],
    }).compile();
    gateway = module.get<RealtimeGateway>(RealtimeGateway);
  });

  it('decrements presence without broadcasting offline when a second authenticated socket remains connected', async () => {
    const client = makeClient('buyer') as ReturnType<typeof makeClient> & { _connectionLeaseRegistered: boolean; _presenceRegistered: boolean };
    client._connectionLeaseRegistered = true;
    client._presenceRegistered = true;

    await gateway.handleDisconnect(client as never);

    expect(mockRealtimeService.setUserPresence).toHaveBeenCalledWith('buyer', false);
    expect(mockPrisma.order.findMany).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway — active connection counter lease', () => {
  let gateway: RealtimeGateway;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: RealtimeService, useValue: mockRealtimeService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
      ],
    }).compile();
    gateway = module.get<RealtimeGateway>(RealtimeGateway);
  });

  it('refreshes the short connection lease for an authenticated active socket', async () => {
    const client = makeClient('buyer');
    (client as unknown as { _tokenExp: number })._tokenExp = Math.floor(Date.now() / 1000) + 600;
    (gateway as unknown as { server: unknown }).server = { sockets: { sockets: new Map([[client.id, client]]) } };

    (gateway as unknown as { recheckTokenExpiry: () => void }).recheckTokenExpiry();
    await Promise.resolve();

    expect(mockRedis.expire).toHaveBeenCalledWith('ws:conn:buyer', 1200);
  });
});

describe('RealtimeGateway — unread notification count', () => {
  let gateway: RealtimeGateway;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: RealtimeService, useValue: mockRealtimeService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
      ],
    }).compile();
    gateway = module.get<RealtimeGateway>(RealtimeGateway);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits a badge count using the same active, non-deleted definition as the inbox', async () => {
    let handler: ((data: { userId: string; title: string; body: string }) => Promise<void>) | undefined;
    mockPrisma.onNotificationCreated.mockImplementation((callback: typeof handler) => { handler = callback; });
    mockPrisma.notification.count.mockResolvedValue(3);

    gateway.afterInit({} as never);
    await handler?.({ userId: 'buyer', title: 'Order update', body: 'Updated' });

    expect(mockPrisma.notification.count).toHaveBeenCalledWith({
      where: {
        userId: 'buyer',
        isRead: false,
        deletedAt: null,
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] }],
      },
    });
    expect(mockRealtimeService.emitToUser).toHaveBeenCalledWith('buyer', 'notification.unread_count', { unreadCount: 3 });
  });
});

/*
 * DC-01 regression: nothing in the codebase ever wrote `DisputeCall.startedAt`. Its only other
 * occurrence was the `startedAt: null` predicate in `expire-dispute-calls.service.ts`, which
 * reaps ACCEPTED calls that nobody joined. With the column never written that predicate was
 * unconditionally true, so the cron flipped EVERY accepted call to EXPIRED 10 minutes after
 * acceptance — including calls two participants were actively talking on — after which this
 * handler and `validateCallParticipant` refused all further signalling and the call dropped.
 * `IN_PROGRESS` was likewise unreachable and `durationSeconds` was 0 for every call.
 *
 * Joining is the only moment a call actually starts, so it is the only place that can stamp it.
 */
const CALL_ID = 'ckdisputecall001';
const DISPUTE_ID = 'ckdispute0001';

describe('RealtimeGateway — dispute call start (DC-01)', () => {
  let gateway: RealtimeGateway;
  let disputeCall: { findUnique: jest.Mock; updateMany: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.incr.mockResolvedValue(1);
    disputeCall = { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        { provide: PrismaService, useValue: { ...mockPrisma, disputeCall } },
        { provide: RedisService, useValue: mockRedis },
        { provide: RealtimeService, useValue: mockRealtimeService },
        { provide: JwtService, useValue: { verifyAsync: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
      ],
    }).compile();
    gateway = module.get<RealtimeGateway>(RealtimeGateway);
  });

  const arrangeCall = (status: string) =>
    disputeCall.findUnique.mockResolvedValue({
      id: CALL_ID,
      status,
      startedAt: null,
      dispute: { order: { buyerId: 'buyer', sellerId: 'seller' } },
    });

  it('stamps startedAt and moves ACCEPTED -> IN_PROGRESS on first join', async () => {
    arrangeCall('ACCEPTED');
    const client = makeClient('buyer');

    const res = await gateway.handleCallJoin(client as never, { disputeId: DISPUTE_ID, callId: CALL_ID });

    expect(res).toEqual({ success: true, started: true });
    expect(disputeCall.updateMany).toHaveBeenCalledWith({
      where: { id: CALL_ID, status: 'ACCEPTED' },
      data: { status: 'IN_PROGRESS', startedAt: expect.any(Date) },
    });
    expect(client.join).toHaveBeenCalledWith(`dispute-call:${CALL_ID}`);
  });

  it('lets the second peer join without erroring when the transition is already done', async () => {
    arrangeCall('IN_PROGRESS');
    disputeCall.updateMany.mockResolvedValue({ count: 0 });
    const client = makeClient('seller');

    const res = await gateway.handleCallJoin(client as never, { disputeId: DISPUTE_ID, callId: CALL_ID });

    // count === 0 means someone else won the transition, not a failure.
    expect(res).toEqual({ success: true, started: false });
    expect(client.join).toHaveBeenCalledWith(`dispute-call:${CALL_ID}`);
  });

  it('refuses a non-participant and never starts the call', async () => {
    arrangeCall('ACCEPTED');
    const client = makeClient('attacker');

    const res = await gateway.handleCallJoin(client as never, { disputeId: DISPUTE_ID, callId: CALL_ID });

    expect(res).toEqual({ success: false, message: 'Not a participant' });
    expect(disputeCall.updateMany).not.toHaveBeenCalled();
    expect(client.join).not.toHaveBeenCalled();
  });

  it('refuses to start a call the cron already EXPIRED', async () => {
    arrangeCall('EXPIRED');
    const client = makeClient('buyer');

    const res = await gateway.handleCallJoin(client as never, { disputeId: DISPUTE_ID, callId: CALL_ID });

    expect(res).toEqual({ success: false, message: 'Call is not active' });
    expect(disputeCall.updateMany).not.toHaveBeenCalled();
  });
});
