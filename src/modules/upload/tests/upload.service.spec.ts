import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadService } from '../upload.service';
import { RedisService } from '../../../redis/redis.service';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  HeadObjectCommandOutput: jest.fn(),
  GetObjectCommand: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const userId = 'user-001';
const ktpFileKey = `uploads/kyc-ktp/${userId}/abc123-ktp.jpg`;
const evidenceFileKey = `uploads/dispute-evidence/${userId}/evidence.jpg`;

const mockRedis = {
  setNx: jest.fn(),
  del: jest.fn(),
  get: jest.fn(),
  consumeOnce: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string) => {
    const map: Record<string, string> = {
      'r2.bucketPrivate': 'private-bucket',
      'r2.bucketPublic': 'public-bucket',
      'r2.accessKeyId': 'test-key',
      'r2.secretAccessKey': 'test-secret',
      'r2.endpointUrl': 'https://test.r2.cloudflarestorage.com',
    };
    return map[key] ?? null;
  }),
};

describe('UploadService — confirmUpload', () => {
  let service: UploadService;
  let s3Send: jest.Mock;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadService,
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<UploadService>(UploadService);

    const { S3Client } = await import('@aws-sdk/client-s3');
    s3Send = jest.fn();
    (S3Client as jest.Mock).mockImplementation(() => ({ send: s3Send }));
    (service as unknown as { _s3Client: null })._s3Client = null;

    jest.clearAllMocks();
    mockConfig.get.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        'r2.bucketPrivate': 'private-bucket',
        'r2.bucketPublic': 'public-bucket',
        'r2.accessKeyId': 'test-key',
        'r2.secretAccessKey': 'test-secret',
        'r2.endpointUrl': 'https://test.r2.cloudflarestorage.com',
      };
      return map[key] ?? null;
    });
  });

  it('should throw BAD_REQUEST if fileKey does not belong to the user', async () => {
    await expect(
      service.confirmUpload('other-user', ktpFileKey),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('should return confirmed:true on first confirmation', async () => {
    mockRedis.setNx.mockResolvedValueOnce(true);
    const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
    s3Send = jest.fn()
      .mockResolvedValueOnce({ ContentLength: 1024, ContentType: 'image/jpeg' })
      .mockResolvedValueOnce({ Body: (async function* () { yield jpegHeader; })() });
    (service as unknown as { _s3Client: { send: jest.Mock } | null })._s3Client = { send: s3Send };

    const result = await service.confirmUpload(userId, ktpFileKey);
    expect(result).toEqual({ fileKey: ktpFileKey, confirmed: true });
    expect(mockRedis.setNx).toHaveBeenCalledWith(
      `confirmed_upload:${userId}:${ktpFileKey}`,
      '1',
      86400,
    );
  });

  it('should throw UPLOAD_ALREADY_CONFIRMED on second confirmation (replay attack)', async () => {
    mockRedis.setNx.mockResolvedValueOnce(false);

    await expect(
      service.confirmUpload(userId, ktpFileKey),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      service.confirmUpload(userId, ktpFileKey),
    ).rejects.toMatchObject({
      response: { code: 'UPLOAD_ALREADY_CONFIRMED' },
    });
  });

  it('should roll back Redis key and throw NOT_FOUND if R2 HeadObject fails', async () => {
    mockRedis.setNx.mockResolvedValueOnce(true);
    mockRedis.del.mockResolvedValueOnce(1);
    s3Send = jest.fn().mockRejectedValueOnce(new Error('NoSuchKey'));
    (service as unknown as { _s3Client: { send: jest.Mock } | null })._s3Client = { send: s3Send };

    await expect(
      service.confirmUpload(userId, ktpFileKey),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(mockRedis.del).toHaveBeenCalledWith(`confirmed_upload:${userId}:${ktpFileKey}`);
  });

  it('should roll back Redis key and throw BAD_REQUEST if ContentType is not allowed', async () => {
    mockRedis.setNx.mockResolvedValueOnce(true);
    mockRedis.del.mockResolvedValueOnce(1);
    s3Send = jest.fn().mockResolvedValueOnce({ ContentLength: 1024, ContentType: 'application/x-msdownload' });
    (service as unknown as { _s3Client: { send: jest.Mock } | null })._s3Client = { send: s3Send };

    await expect(
      service.confirmUpload(userId, ktpFileKey),
    ).rejects.toMatchObject({
      response: { code: 'MIME_TYPE_MISMATCH' },
    });

    expect(mockRedis.del).toHaveBeenCalledWith(`confirmed_upload:${userId}:${ktpFileKey}`);
  });

  it('consumes a confirmed evidence key atomically during single validation', async () => {
    mockRedis.get.mockResolvedValueOnce('1');
    mockRedis.consumeOnce.mockResolvedValueOnce(true);
    s3Send = jest.fn().mockResolvedValueOnce({ ContentLength: 1024 });
    (service as unknown as { _s3Client: { send: jest.Mock } | null })._s3Client = { send: s3Send };

    await expect(service.verifyEvidenceFileKeys(userId, [evidenceFileKey])).resolves.toBeUndefined();
    expect(mockRedis.consumeOnce).toHaveBeenCalledWith(`confirmed_upload:${userId}:${evidenceFileKey}`, { throwOnError: true });
  });

  it('rejects an evidence key already consumed by another request', async () => {
    mockRedis.get.mockResolvedValueOnce('1');
    mockRedis.consumeOnce.mockResolvedValueOnce(false);
    s3Send = jest.fn().mockResolvedValueOnce({ ContentLength: 1024 });
    (service as unknown as { _s3Client: { send: jest.Mock } | null })._s3Client = { send: s3Send };

    await expect(service.verifyEvidenceFileKeys(userId, [evidenceFileKey])).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_CONFIRMED' } });
  });

  it('returns one success and one error for duplicate parallel batch use', async () => {
    mockRedis.get.mockResolvedValue('1');
    mockRedis.consumeOnce.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    s3Send = jest.fn().mockResolvedValue({ ContentLength: 1024 });
    (service as unknown as { _s3Client: { send: jest.Mock } | null })._s3Client = { send: s3Send };

    const result = await service.verifyEvidenceFileKeysBatch(userId, [evidenceFileKey, evidenceFileKey], ['image/jpeg', 'image/jpeg']);
    expect(result.map((item) => item.status)).toEqual(['ok', 'error']);
  });

  it('should roll back Redis key and throw BAD_REQUEST if file exceeds max size', async () => {
    mockRedis.setNx.mockResolvedValueOnce(true);
    mockRedis.del.mockResolvedValueOnce(1);
    const oversize = 6 * 1024 * 1024;
    s3Send = jest.fn().mockResolvedValueOnce({ ContentLength: oversize, ContentType: 'image/jpeg' });
    (service as unknown as { _s3Client: { send: jest.Mock } | null })._s3Client = { send: s3Send };

    await expect(
      service.confirmUpload(userId, ktpFileKey),
    ).rejects.toMatchObject({
      response: { code: 'FILE_TOO_LARGE' },
    });

    expect(mockRedis.del).toHaveBeenCalledWith(`confirmed_upload:${userId}:${ktpFileKey}`);
  });

  it('should validate ownership and safe key shape before checking confirmation Redis', async () => {
    const malformedKeys = [
      `uploads/kyc-ktp/${userId}/../other/ktp.jpg`,
      `uploads/unknown/${userId}/file.jpg`,
      `uploads/kyc-ktp/other-user/file.jpg`,
    ];

    for (const key of malformedKeys) {
      await expect(service.isConfirmedUploadKey(userId, key)).resolves.toBe(false);
    }
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('should check Redis only for a valid confirmed key', async () => {
    mockRedis.get.mockResolvedValueOnce('1');

    await expect(service.isConfirmedUploadKey(userId, ktpFileKey)).resolves.toBe(true);
    expect(mockRedis.get).toHaveBeenCalledWith(`confirmed_upload:${userId}:${ktpFileKey}`);
  });

  it('rejects an attachment key with the wrong purpose before Redis/S3 access', async () => {
    await expect(service.verifyUserFileKeys(userId, [evidenceFileKey], 'CHAT_ATTACHMENT' as any)).rejects.toMatchObject({ response: { code: 'FILE_ACCESS_DENIED' } });
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('rejects duplicate attachment keys before consuming confirmation', async () => {
    const chatKey = `uploads/chat-attachments/${userId}/chat.jpg`;
    await expect(service.verifyUserFileKeys(userId, [chatKey, chatKey], 'CHAT_ATTACHMENT' as any)).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    expect(mockRedis.consumeOnce).not.toHaveBeenCalled();
  });

  it('fails closed when confirmed attachment storage metadata is incomplete', async () => {
    const chatKey = `uploads/chat-attachments/${userId}/chat.jpg`;
    mockRedis.get.mockResolvedValueOnce('1');
    s3Send = jest.fn().mockResolvedValueOnce({ ContentType: 'image/jpeg' });
    (service as unknown as { _s3Client: { send: jest.Mock } | null })._s3Client = { send: s3Send };
    await expect(service.verifyUserFileKeys(userId, [chatKey], 'CHAT_ATTACHMENT' as any)).rejects.toMatchObject({ response: { code: 'FILE_TOO_LARGE' } });
    expect(mockRedis.consumeOnce).not.toHaveBeenCalled();
  });

  it('rejects unsafe keys before signing a download URL', async () => {
    await expect(service.generateDownloadUrl('uploads/chat-attachments/user-001/../secret')).rejects.toMatchObject({ response: { code: 'INVALID_FILE_TYPE' } });
  });
});
