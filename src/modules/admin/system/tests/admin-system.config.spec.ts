import { ConflictException } from '@nestjs/common';
import { AdminSystemService } from '../admin-system.service';

describe('AdminSystemService config approval controls', () => {
  const prisma = {
    systemConfig: { findUnique: jest.fn(), update: jest.fn() },
  };
  const redis = {
    get: jest.fn(),
    set: jest.fn(),
    setNx: jest.fn(),
    del: jest.fn(),
    releaseLock: jest.fn(),
    scan: jest.fn(),
    getPrefix: jest.fn(),
  };
  const auditLogService = { logAdminAction: jest.fn() };
  let service: AdminSystemService;

  beforeEach(() => {
    jest.resetAllMocks();
    redis.setNx.mockResolvedValue(true);
    redis.del.mockResolvedValue(undefined);
    redis.releaseLock.mockResolvedValue(true);
    service = new AdminSystemService(prisma as never, redis as never, auditLogService as never, { enqueueMany: jest.fn() } as never);
  });

  it('does not overwrite an existing pending financial config proposal', async () => {
    prisma.systemConfig.findUnique.mockResolvedValue({ id: 'cfg-1', key: 'platform_fee', value: '1', description: null, dataType: 'NUMBER' });
    redis.setNx.mockResolvedValueOnce(false);

    await expect(service.updateConfig('platform_fee', { value: '2' } as never, 'admin-1', '127.0.0.1'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(auditLogService.logAdminAction).not.toHaveBeenCalled();
  });

  it('rejects concurrent approval while the config key lock is held', async () => {
    redis.setNx.mockResolvedValue(false);
    await expect(service.approveConfigChange('platform_fee', 'admin-2', '127.0.0.1'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(redis.get).not.toHaveBeenCalled();
  });
});
