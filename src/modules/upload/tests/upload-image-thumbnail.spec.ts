/**
 * PERF-FIX (NP-001): unit test thumbnail foto showcase (sharp, ~640px).
 * sharp di-mock (unit murni, tanpa native libvips) — yang diuji adalah
 * wiring-nya: key thumbnail, penandaan confirmed, URL publik, dan perilaku
 * fail-open bila sharp gagal.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UploadService } from '../upload.service';
import { RedisService } from '../../../redis/redis.service';
import { LocalStorageService } from '../local-storage.service';
import { VideoProcessingService } from '../video-processing.service';

// Mock sharp SEBELUM service di-import: rantai fluent rotate→resize→jpeg→toFile.
jest.mock('sharp', () => {
  const toFile = jest.fn().mockResolvedValue({ format: 'jpeg', width: 640, height: 480 });
  const jpeg = jest.fn(() => ({ toFile }));
  const resize = jest.fn(() => ({ jpeg }));
  const rotate = jest.fn(() => ({ resize }));
  const sharpFn = jest.fn(() => ({ rotate }));
  return {
    __esModule: true,
    default: sharpFn,
    __mocks: { sharpFn, rotate, resize, jpeg, toFile },
  };
});

type SharpMocks = {
  sharpFn: jest.Mock;
  rotate: jest.Mock;
  resize: jest.Mock;
  jpeg: jest.Mock;
  toFile: jest.Mock;
};
const sharpMocks = (jest.requireMock('sharp') as { __mocks: SharpMocks }).__mocks;

const userId = 'user-001';
const imageFileKey = `uploads/showcase-images/${userId}/1700000000000-a1b2c3d4e5-foto.jpg`;

const mockRedis = { setNx: jest.fn(), del: jest.fn(), get: jest.fn(), consumeOnce: jest.fn() };
const mockLocalStorage = {
  resolvePath: jest.fn((key: string) => `/tmp/kahade-thumb-test/${key}`),
  getPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
  deleteFile: jest.fn().mockResolvedValue(true),
};
const mockConfig = { get: jest.fn(() => null) };
const mockVideoProcessing = { isAvailable: jest.fn(), probeVideo: jest.fn(), generateThumbnail: jest.fn() };

describe('UploadService — processShowcaseImage (PERF-FIX NP-001)', () => {
  let service: UploadService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadService,
        { provide: RedisService, useValue: mockRedis },
        { provide: ConfigService, useValue: mockConfig },
        { provide: LocalStorageService, useValue: mockLocalStorage },
        { provide: VideoProcessingService, useValue: mockVideoProcessing },
      ],
    }).compile();
    service = module.get<UploadService>(UploadService);
    jest.clearAllMocks();
    // clearAllMocks menghapus implementasi mock di atas — pasang ulang.
    mockLocalStorage.resolvePath.mockImplementation((key: string) => `/tmp/kahade-thumb-test/${key}`);
    mockLocalStorage.getPublicUrl.mockImplementation((key: string) => `https://cdn.test/${key}`);
    mockLocalStorage.deleteFile.mockResolvedValue(true);
    mockRedis.setNx.mockResolvedValue(true);
    sharpMocks.toFile.mockResolvedValue({ format: 'jpeg', width: 640, height: 480 });
  });

  function callPrivate(buffer: Buffer): Promise<{ thumbnailFileKey?: string; thumbnailUrl?: string }> {
    return (service as unknown as {
      processShowcaseImage: (u: string, k: string, b: Buffer) => Promise<{ thumbnailFileKey?: string; thumbnailUrl?: string }>;
    }).processShowcaseImage(userId, imageFileKey, buffer);
  }

  it('membuat thumbnail JPEG ~640px dan mengembalikan key + URL publik', async () => {
    const buffer = Buffer.from('fake-jpeg-bytes');
    const result = await callPrivate(buffer);

    expect(result.thumbnailFileKey).toMatch(
      new RegExp(`^uploads/showcase-images/${userId}/\\d+-thumb-[A-Za-z0-9]+\\.jpg$`),
    );
    expect(result.thumbnailUrl).toBe(`https://cdn.test/${result.thumbnailFileKey}`);

    // sharp dipanggil dengan buffer ASLI (bukan hasil strip metadata —
    // orientasi EXIF masih utuh untuk .rotate()).
    expect(sharpMocks.sharpFn).toHaveBeenCalledWith(buffer);
    expect(sharpMocks.rotate).toHaveBeenCalled();
    expect(sharpMocks.resize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 640, withoutEnlargement: true }),
    );
    expect(sharpMocks.jpeg).toHaveBeenCalledWith(expect.objectContaining({ quality: 80 }));
    // Thumbnail ditulis ke folder showcase-images milik user yang sama.
    expect(sharpMocks.toFile).toHaveBeenCalledWith(
      expect.stringContaining(`/tmp/kahade-thumb-test/uploads/showcase-images/${userId}/`),
    );
    // Ditandai confirmed supaya bisa dilampirkan sebagai thumbnailFileKey.
    expect(mockRedis.setNx).toHaveBeenCalledWith(
      `confirmed_upload:${userId}:${result.thumbnailFileKey}`,
      '1',
      86400,
    );
  });

  it('fail-open: sharp gagal → upload tetap lanjut tanpa thumbnail (tidak throw)', async () => {
    sharpMocks.toFile.mockRejectedValueOnce(new Error('libvips boom'));
    const result = await callPrivate(Buffer.from('fake-jpeg-bytes'));

    expect(result).toEqual({});
    // Thumbnail setengah-jadi dibersihkan; upload foto tidak gagal.
    expect(mockLocalStorage.deleteFile).toHaveBeenCalledWith(expect.stringContaining('-thumb-'));
    expect(mockRedis.setNx).not.toHaveBeenCalled();
  });

  it('tidak pernah membuat thumbnail untuk fileKey di luar folder user', async () => {
    // Guard bentuk key (isSafeFileKey-style): thumbKey selalu dibangun dari
    // userId terotentikasi, bukan dari input user.
    const result = await callPrivate(Buffer.from('x'));
    expect(result.thumbnailFileKey).toContain(`/showcase-images/${userId}/`);
    expect(result.thumbnailFileKey).not.toContain('..');
  });
});
