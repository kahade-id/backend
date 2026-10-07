/**
 * Regresi Bug #1 (chat attachment tidak bisa dilihat): alur BACA lampiran
 * chat diuji end-to-end lewat HTTP nyata:
 *
 *   1. `POST /v1/chat/rooms/:roomId/upload` (UploadController pipeline asli)
 *   2. `POST /v1/chat/rooms/:roomId/messages` dengan signed URL hasil upload
 *      (persis yang dikirim FE) → assert bentuk yang DIPERSIST di DB
 *   3. `GET  /v1/chat/rooms/:roomId/messages` → assert signed URL segar
 *   4. `GET  /v1/upload/s?key=&exp=&sig=` → assert byte + Content-Type + Range
 *
 * Yang diuji adalah kode produksi apa adanya (UploadService, ChatService,
 * LocalStorageService, kedua controller, global ResponseTransformInterceptor
 * seperti di main.ts). Hanya Prisma/Redis/Socket yang diganti fake in-memory.
 *
 * Tanpa interceptor di jalur respons, `StreamableFile` dari endpoint download
 * berubah menjadi JSON `{success:true,data:{}}` — foto tampil kotak rusak,
 * video "gagal dimuat", dan PDF terbuka sebagai JSON.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';

import { ChatController } from '../chat.controller';
import { ChatService } from '../chat.service';
import { UploadController } from '../../upload/upload.controller';
import { UploadService } from '../../upload/upload.service';
import { LocalStorageService } from '../../upload/local-storage.service';
import { VideoProcessingService } from '../../upload/video-processing.service';
import { ChunkedUploadService } from '../../upload/chunked-upload.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { VerificationBadgeService } from '../../users/verification-badge.service';
import { OrdersService } from '../../orders/orders.service';
import { TranslationService } from '../translation/translation.service';
import { PhoneVerifiedGuard } from '../../../common/guards/phone-verified.guard';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { ResponseTransformInterceptor } from '../../../common/interceptors/response-transform.interceptor';
import { HttpExceptionFilter } from '../../../common/filters/http-exception.filter';

const BUYER = 'clxbuyer0000000000000001';
const SELLER = 'clxseller000000000000002';
const ROOM_ID = 'clxroom00000000000000001';
const SIGNING_SECRET = 'unit-test-storage-signing-secret-0123456789';

// ─── Fake Prisma (in-memory, hanya yang dipakai jalur yang diuji) ─────────────

interface FakeAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  thumbnailUrl: string | null;
  createdAt: Date;
}

interface FakeMessage {
  id: string;
  roomId: string;
  senderId: string;
  messageType: string;
  content: string | null;
  isEdited: boolean;
  editedAt: Date | null;
  isDeleted: boolean;
  deletedAt: Date | null;
  isPinned: boolean;
  pinnedAt: Date | null;
  durationSeconds: number | null;
  forwardedFromId: string | null;
  readAt: Record<string, unknown> | null;
  ephemeralTtlSeconds: number | null;
  expiresAt: Date | null;
  viewOnce: boolean;
  viewOnceViewedAt: Date | null;
  locationLat: number | null;
  locationLng: number | null;
  locationLabel: string | null;
  cardSnapshot: unknown;
  pollId: string | null;
  poll: null;
  createdAt: Date;
  updatedAt: Date;
  replyToId: string | null;
  replyTo: null;
  forwardedFrom: null;
  sender: { id: string; userId: string; fullName: string; avatarUrl: string | null };
  attachments: FakeAttachment[];
  reactions: never[];
}

function makeFakePrisma() {
  const users = [
    { id: BUYER, userId: 'USR-BUYER001', fullName: 'Buyer', avatarUrl: null, username: 'buyer', isActive: true, isBanned: false, phoneVerified: true, preferredLanguage: 'id' },
    { id: SELLER, userId: 'USR-SELLER02', fullName: 'Seller', avatarUrl: null, username: 'seller', isActive: true, isBanned: false, phoneVerified: true, preferredLanguage: 'id' },
  ];
  const room = {
    id: ROOM_ID,
    type: 'ORDER',
    status: 'ACTIVE',
    subject: null,
    initiatorId: BUYER,
    counterpartId: SELLER,
    deletedAt: null,
    order: {
      id: 'clxorder00000000000000001',
      orderId: 'ORD-20261007-000001-AAAA',
      status: 'PROCESSING',
      completedAt: null,
      cancelledAt: null,
      buyerId: BUYER,
      sellerId: SELLER,
      deletedAt: null,
    },
  };

  const messages: FakeMessage[] = [];
  const created: { attachments?: Array<Record<string, unknown>> }[] = [];

  const userById = (id: string) => users.find((u) => u.id === id);
  const toRawMessage = (m: FakeMessage): FakeMessage => m;

  const prisma: Record<string, any> = {
    chatRoom: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === room.id ? room : null)),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => [room]),
      count: jest.fn(async () => 0),
      create: jest.fn(),
      update: jest.fn(async () => room),
    },
    chatRoomMember: {
      upsert: jest.fn(async () => ({ id: 'member-1' })),
      update: jest.fn(async () => ({ id: 'member-1' })),
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
    },
    chatMessage: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const attachmentRows = (data.attachments as { create?: Array<Record<string, unknown>> } | undefined)?.create ?? [];
        created.push({ attachments: attachmentRows });
        const now = new Date();
        const message: FakeMessage = {
          id: String(data.id),
          roomId: String(data.roomId),
          senderId: String(data.senderId),
          messageType: String(data.messageType),
          content: (data.content as string | null) ?? null,
          isEdited: false,
          editedAt: null,
          isDeleted: false,
          deletedAt: null,
          isPinned: false,
          pinnedAt: null,
          durationSeconds: (data.durationSeconds as number | null) ?? null,
          forwardedFromId: null,
          readAt: null,
          ephemeralTtlSeconds: (data.ephemeralTtlSeconds as number | null) ?? null,
          expiresAt: (data.expiresAt as Date | null) ?? null,
          viewOnce: Boolean(data.viewOnce),
          viewOnceViewedAt: null,
          locationLat: (data.locationLat as number | null) ?? null,
          locationLng: (data.locationLng as number | null) ?? null,
          locationLabel: (data.locationLabel as string | null) ?? null,
          cardSnapshot: null,
          pollId: null,
          poll: null,
          createdAt: now,
          updatedAt: now,
          replyToId: (data.replyToId as string | null) ?? null,
          replyTo: null,
          forwardedFrom: null,
          sender: userById(String(data.senderId))!,
          // Bentuk baris `chat_attachments` setelah Prisma menyimpannya.
          attachments: attachmentRows.map((a, i) => ({
            id: `att-${i + 1}`,
            fileName: String(a.fileName),
            fileSize: Number(a.fileSize),
            mimeType: String(a.mimeType),
            fileUrl: String(a.fileUrl),
            thumbnailUrl: (a.thumbnailUrl as string | null) ?? null,
            createdAt: now,
          })),
          reactions: [],
        };
        messages.push(message);
        return toRawMessage(message);
      }),
      findMany: jest.fn(async ({ where }: { where: { roomId: string } }) =>
        messages
          .filter((m) => m.roomId === where.roomId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
      findFirst: jest.fn(async ({ where }: { where: { id?: string; roomId?: string } }) =>
        messages.find((m) => (!where.id || m.id === where.id) && (!where.roomId || m.roomId === where.roomId)) ?? null,
      ),
      count: jest.fn(async () => messages.length),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    chatMessageReaction: { findMany: jest.fn(async () => []) },
    chatAttachment: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    chatModerationEvent: { create: jest.fn(async () => ({ id: 'cme-1' })) },
    chatPinnedRoom: { findMany: jest.fn(async () => []) },
    chatStarredMessage: { findMany: jest.fn(async () => []) },
    privacySetting: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      upsert: jest.fn(),
    },
    notificationPreference: { findUnique: jest.fn(async () => null) },
    blockList: { findFirst: jest.fn(async () => null) },
    dispute: { findFirst: jest.fn(async () => null) },
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => userById(where.id) ?? null),
      findMany: jest.fn(async () => users),
    },
    userFollow: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    notification: { create: jest.fn(async () => ({ notifId: 'NTF-1' })) },
    emitNotificationCreated: jest.fn(),
    // `$transaction(async (tx) => ...)` — tx = prisma itu sendiri.
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
  };
  return { prisma, messages, created };
}

// ─── Fake Redis (in-memory) ──────────────────────────────────────────────────

function makeFakeRedis() {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    del: jest.fn(async (k: string) => { store.delete(k); }),
    delPattern: jest.fn(async () => undefined),
    incr: jest.fn(async () => 1),
    incrWithTtl: jest.fn(async () => 1),
    incrBy: jest.fn(async () => 1),
    expire: jest.fn(async () => undefined),
    exists: jest.fn(async (k: string) => (store.has(k) ? 1 : 0)),
    setNx: jest.fn(async (k: string, v: string) => {
      if (store.has(k)) return false;
      store.set(k, v);
      return true;
    }),
    consumeOnce: jest.fn(async (k: string) => {
      if (store.has(k)) return false;
      store.set(k, '1');
      return true;
    }),
    keys: jest.fn(async () => [] as string[]),
    ttl: jest.fn(async () => -1),
    getLastSeenMany: jest.fn(async () => ({})),
  };
}

describe('Bug #1 — lampiran chat bisa diunduh (upload → send → read → GET /v1/upload/s)', () => {
  let app: INestApplication;
  let storageRoot: string;
  let fake: ReturnType<typeof makeFakePrisma>;
  let realtime: Record<string, jest.Mock>;
  let jpeg: Buffer;
  let pdf: Buffer;

  const authHeader = { Authorization: 'Bearer test' };

  beforeAll(async () => {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kahade-chat-att-'));
    // > MIN_FILE_SIZE (1024 B) supaya lolos validasi upload.
    const noise = Buffer.alloc(128 * 128 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + ((i * i) % 251)) % 256;
    jpeg = await sharp(noise, { raw: { width: 128, height: 128, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    expect(jpeg.length).toBeGreaterThan(1024);
    pdf = Buffer.concat([
      Buffer.from(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n',
        'latin1',
      ),
      Buffer.from(`%${' pad'.repeat(400)}\n`, 'latin1'),
      Buffer.from('trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'),
    ]);
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');

    fake = makeFakePrisma();
    const redis = makeFakeRedis();

    const configValues: Record<string, unknown> = {
      'app.storagePath': storageRoot,
      'app.storagePublicUrl': 'https://api.kahade.id/uploads',
      'STORAGE_URL_SECRET': SIGNING_SECRET,
      'jwt.secret': SIGNING_SECRET.repeat(2),
    };

    realtime = {
      emitToChatRoom: jest.fn(),
      emitToOrder: jest.fn(),
      emitToUser: jest.fn(),
      broadcastToRoom: jest.fn(),
      notifyUser: jest.fn(),
      areUsersOnline: jest.fn(async () => ({})),
      isUserOnline: jest.fn(async () => false),
      getLastSeen: jest.fn(async () => null),
      getLastSeenMany: jest.fn(async () => ({})),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController, UploadController],
      providers: [
        ChatService,
        UploadService,
        LocalStorageService,
        VideoProcessingService,
        ChunkedUploadService,
        { provide: PrismaService, useValue: fake.prisma },
        { provide: RedisService, useValue: redis },
        { provide: RealtimeService, useValue: realtime },
        { provide: NotificationsService, useValue: { create: jest.fn(), isInAppEnabled: jest.fn(async () => true) } },
        { provide: VerificationBadgeService, useValue: { getSealTierMap: jest.fn(async () => new Map()) } },
        { provide: OrdersService, useValue: {} },
        { provide: TranslationService, useValue: {} },
        { provide: ConfigService, useValue: { get: (k: string) => configValues[k] } },
      ],
    })
      .overrideGuard(PhoneVerifiedGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottleGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    // Cermin main.ts: prefix + pipe + interceptor + filter global.
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalInterceptors(new ResponseTransformInterceptor(app.get(Reflector)));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      // Ganti JwtAuthGuard (tidak dipasang di modul uji) dengan user tetap.
      (req as { user?: unknown }).user = { sub: BUYER, userId: 'USR-BUYER001' };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Payload socket di-assert per test — bersihkan agar tidak tertukar
    // dengan emit dari test sebelumnya.
    for (const fn of Object.values(realtime)) fn.mockClear();
  });

  function dataOf<T>(body: unknown): T {
    const b = body as { data?: T } & T;
    return (b?.data ?? b) as T;
  }

  function assertSignedUrl(signedUrl: string): URL {
    const url = new URL(signedUrl);
    expect(url.pathname).toBe('/v1/upload/s');
    expect(url.searchParams.get('key')).toBeTruthy();
    expect(url.searchParams.get('exp')).toBeTruthy();
    expect(url.searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
    return url;
  }

  it('upload foto → file tersimpan sebagai fileKey privat + signed URL valid', async () => {
    const res = await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/upload`)
      .set(authHeader)
      .attach('file', jpeg, { filename: 'foto.jpg', contentType: 'image/jpeg' })
      .expect(200);

    const data = dataOf<{ fileUrl: string; fileKey: string; fileName: string; mimeType: string }>(res.body);
    expect(data.fileKey).toMatch(new RegExp(`^uploads/chat-attachments/${BUYER}/[0-9]+-[A-Za-z0-9]+-foto\\.jpg$`));
    expect(data.mimeType).toBe('image/jpeg');
    expect(data.fileName).toBe('foto.jpg');
    // Signed URL privat (900s) — bukan URL publik permanen.
    const url = assertSignedUrl(data.fileUrl);
    expect(url.searchParams.get('key')).toBe(data.fileKey);
    expect(fs.existsSync(path.join(storageRoot, data.fileKey.replace(/^uploads\//, '')))).toBe(true);
  });

  it('signed URL dari upload dapat diunduh: byte utuh + Content-Type benar', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/upload`)
      .set(authHeader)
      .attach('file', jpeg, { filename: 'foto2.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const signedUrl = dataOf<{ fileUrl: string }>(upload.body).fileUrl;
    const url = assertSignedUrl(signedUrl);

    const download = await request(app.getHttpServer())
      .get(`/v1/upload/s?key=${encodeURIComponent(url.searchParams.get('key')!)}&exp=${url.searchParams.get('exp')}&sig=${url.searchParams.get('sig')}`)
      .expect(200);

    expect(download.headers['content-type']).toContain('image/jpeg');
    expect(download.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.isBuffer(download.body)).toBe(true);
    expect(download.body.length).toBe(jpeg.length);
    expect(download.body.equals(jpeg)).toBe(true);
  });

  it('PDF diunduh sebagai application/pdf (bukan JSON)', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/upload`)
      .set(authHeader)
      .attach('file', pdf, { filename: 'dokumen.pdf', contentType: 'application/pdf' })
      .expect(200);
    const url = assertSignedUrl(dataOf<{ fileUrl: string }>(upload.body).fileUrl);

    const download = await request(app.getHttpServer())
      .get(`/v1/upload/s?key=${encodeURIComponent(url.searchParams.get('key')!)}&exp=${url.searchParams.get('exp')}&sig=${url.searchParams.get('sig')}`)
      .expect(200);

    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.body.equals(pdf)).toBe(true);
  });

  it('Range request video didukung (206 + Content-Range)', async () => {
    // MP4 minimal: magic-byte ftyp isom (box-size 8..4096).
    const mp4 = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
      Buffer.alloc(4096, 0x21),
    ]);
    const upload = await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/upload`)
      .set(authHeader)
      .attach('file', mp4, { filename: 'klip.mp4', contentType: 'video/mp4' })
      .expect(200);
    const url = assertSignedUrl(dataOf<{ fileUrl: string }>(upload.body).fileUrl);

    const ranged = await request(app.getHttpServer())
      .get(`/v1/upload/s?key=${encodeURIComponent(url.searchParams.get('key')!)}&exp=${url.searchParams.get('exp')}&sig=${url.searchParams.get('sig')}`)
      .set('Range', 'bytes=0-99')
      .expect(206);

    expect(ranged.headers['content-range']).toBe(`bytes 0-99/${mp4.length}`);
    expect(ranged.body.length).toBe(100);
    expect(ranged.body.equals(mp4.subarray(0, 100))).toBe(true);
  });

  it('kirim pesan dengan signed URL → yang DIPERSIST adalah fileKey mentah', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/upload`)
      .set(authHeader)
      .attach('file', jpeg, { filename: 'kirim.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const uploaded = dataOf<{ fileUrl: string; fileKey: string }>(upload.body);

    await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/messages`)
      .set(authHeader)
      .send({
        messageType: 'IMAGE',
        attachments: [{
          fileName: 'kirim.jpg',
          fileUrl: uploaded.fileUrl, // FE mengirim signed URL hasil upload
          mimeType: 'image/jpeg',
          fileSize: jpeg.length,
        }],
      })
      .expect(200);

    const persisted = fake.created.at(-1)?.attachments?.[0];
    expect(persisted).toBeDefined();
    expect(persisted!.fileUrl).toBe(uploaded.fileKey);
    expect(String(persisted!.fileUrl)).not.toContain('sig=');
  });

  it('jalur LIVE: respons kirim + payload socket berisi signed URL yang benar-benar bisa diunduh', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/upload`)
      .set(authHeader)
      .attach('file', jpeg, { filename: 'live.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const uploaded = dataOf<{ fileUrl: string }>(upload.body).fileUrl;

    const send = await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/messages`)
      .set(authHeader)
      .send({
        messageType: 'IMAGE',
        content: 'foto live',
        attachments: [{ fileUrl: uploaded, fileName: 'live.jpg', fileSize: jpeg.length, mimeType: 'image/jpeg' }],
      })
      .expect(200);

    // 1. Respons kirim: fileUrl harus signed URL absolut (bukan fileKey mentah).
    const sentAttachment = dataOf<{ attachments: { fileUrl: string; urlExpiresAt: string | null }[] }>(send.body)
      .attachments[0];
    expect(sentAttachment.fileUrl.startsWith('uploads/')).toBe(false);
    const sentUrl = assertSignedUrl(sentAttachment.fileUrl);
    expect(sentUrl.searchParams.get('key')).toMatch(new RegExp(`^uploads/chat-attachments/${BUYER}/`));
    expect(typeof sentAttachment.urlExpiresAt).toBe('string');

    // 2. Payload socket ke penerima (chat.new_message) juga signed URL — inilah
    //    yang dirender penerima SEBELUM membuka ulang daftar pesan.
    const emitted = realtime.emitToUser.mock.calls.find(
      ([userId, event]) => userId === SELLER && event === 'chat.new_message',
    );
    expect(emitted).toBeDefined();
    const recipientPayload = emitted![2] as { attachments: { fileUrl: string; urlExpiresAt: string | null }[] };
    const socketUrl = assertSignedUrl(recipientPayload.attachments[0].fileUrl);
    expect(socketUrl.searchParams.get('key')).toBe(sentUrl.searchParams.get('key'));
    expect(typeof recipientPayload.attachments[0].urlExpiresAt).toBe('string');

    // 3. Broadcast netral ke room juga signed.
    const broadcast = realtime.emitToChatRoom.mock.calls.find(([, event]) => event === 'chat.new_message');
    expect(broadcast).toBeDefined();
    const neutralPayload = broadcast![2] as { attachments: { fileUrl: string }[] };
    assertSignedUrl(neutralPayload.attachments[0].fileUrl);

    // 4. Dan URL dari payload LIVE benar-benar mengunduh byte yang sama.
    const download = await request(app.getHttpServer())
      .get(`/v1/upload/s?key=${encodeURIComponent(socketUrl.searchParams.get('key')!)}&exp=${socketUrl.searchParams.get('exp')}&sig=${socketUrl.searchParams.get('sig')}`)
      .expect(200)
      .buffer(true);
    expect(download.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.isBuffer(download.body)).toBe(true);
    expect(download.body.equals(jpeg)).toBe(true);
  });

  it('pesan yang di-EDIT/di-PIN/di-SEARCH juga mengembalikan signed URL (bukan fileKey mentah)', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/upload`)
      .set(authHeader)
      .attach('file', jpeg, { filename: 'multi.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const uploaded = dataOf<{ fileUrl: string }>(upload.body).fileUrl;

    const send = await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/messages`)
      .set(authHeader)
      .send({
        messageType: 'IMAGE',
        content: 'akan di-pin',
        attachments: [{ fileUrl: uploaded, fileName: 'multi.jpg', fileSize: jpeg.length, mimeType: 'image/jpeg' }],
      })
      .expect(200);
    const messageId = dataOf<{ id: string }>(send.body).id;

    // Pin pesan → respons tidak boleh membocorkan fileKey mentah.
    await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/messages/${messageId}/pin`)
      .set(authHeader)
      .expect((res) => expect([200, 201]).toContain(res.status));

    const pinned = await request(app.getHttpServer())
      .get(`/v1/chat/rooms/${ROOM_ID}/pins`)
      .set(authHeader)
      .expect(200);
    const pinnedMessages = dataOf<{ messages: { attachments: { fileUrl: string }[] }[] }>(pinned.body).messages;
    expect(pinnedMessages.length).toBeGreaterThan(0);
    for (const msg of pinnedMessages) {
      for (const att of msg.attachments ?? []) {
        expect(att.fileUrl.startsWith('uploads/')).toBe(false);
        assertSignedUrl(att.fileUrl);
      }
    }

    // Pencarian pesan → idem.
    const search = await request(app.getHttpServer())
      .get(`/v1/chat/rooms/${ROOM_ID}/search?q=akan`)
      .set(authHeader)
      .expect(200);
    const found = dataOf<{ messages: { attachments: { fileUrl: string }[] }[] }>(search.body).messages;
    expect(found.length).toBeGreaterThan(0);
    assertSignedUrl(found[0].attachments[0].fileUrl);
  });

  it('GET messages mengembalikan signed URL segar yang benar-benar bisa diunduh', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/upload`)
      .set(authHeader)
      .attach('file', jpeg, { filename: 'baca.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const uploaded = dataOf<{ fileUrl: string; fileKey: string }>(upload.body);

    await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/messages`)
      .set(authHeader)
      .send({
        messageType: 'IMAGE',
        attachments: [{
          fileName: 'baca.jpg',
          fileUrl: uploaded.fileUrl,
          mimeType: 'image/jpeg',
          fileSize: jpeg.length,
          thumbnailUrl: uploaded.fileUrl,
        }],
      })
      .expect(200);

    const list = await request(app.getHttpServer())
      .get(`/v1/chat/rooms/${ROOM_ID}/messages`)
      .set(authHeader)
      .expect(200);

    const messages = dataOf<{ messages: Array<{ attachments: Array<{ fileUrl: string; thumbnailUrl: string | null; urlExpiresAt: string | null }> }> }>(list.body).messages;
    expect(messages.length).toBeGreaterThan(0);
    const attachment = messages.at(-1)!.attachments[0];

    // URL untuk dibaca harus signed URL SEGAR (bukan fileKey mentah).
    expect(attachment.fileUrl).toContain('/v1/upload/s?');
    const fresh = assertSignedUrl(attachment.fileUrl);
    expect(fresh.searchParams.get('key')).toBe(uploaded.fileKey);
    expect(attachment.urlExpiresAt).toBeTruthy();

    // …dan signed URL itu benar-benar mengembalikan byte gambar.
    const download = await request(app.getHttpServer())
      .get(`/v1/upload/s?key=${encodeURIComponent(fresh.searchParams.get('key')!)}&exp=${fresh.searchParams.get('exp')}&sig=${fresh.searchParams.get('sig')}`)
      .expect(200);
    expect(download.headers['content-type']).toContain('image/jpeg');
    expect(download.body.equals(jpeg)).toBe(true);
  });

  it('signed URL kedaluwarsa / rusak ditolak 403 (bukan file)', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/v1/chat/rooms/${ROOM_ID}/upload`)
      .set(authHeader)
      .attach('file', jpeg, { filename: 'expired.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const url = assertSignedUrl(dataOf<{ fileUrl: string }>(upload.body).fileUrl);

    await request(app.getHttpServer())
      .get(`/v1/upload/s?key=${encodeURIComponent(url.searchParams.get('key')!)}&exp=1&sig=${url.searchParams.get('sig')}`)
      .expect(403);

    await request(app.getHttpServer())
      .get(`/v1/upload/s?key=${encodeURIComponent(url.searchParams.get('key')!)}&exp=${url.searchParams.get('exp')}&sig=${'0'.repeat(64)}`)
      .expect(403);
  });
});
