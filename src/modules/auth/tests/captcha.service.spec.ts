import { CaptchaService } from '../captcha.service';

describe('CaptchaService login threshold', () => {
  const redis = {
    get: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    del: jest.fn(),
    set: jest.fn(),
  };
  let service: CaptchaService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CaptchaService(redis as any);
  });

  it('does not require CAPTCHA before three failed attempts', async () => {
    redis.get.mockResolvedValueOnce('2');
    await expect(service.shouldRequireLoginCaptcha('1.2.3.4')).resolves.toBe(false);
  });

  it('requires CAPTCHA at three failed attempts', async () => {
    redis.get.mockResolvedValueOnce('3');
    await expect(service.shouldRequireLoginCaptcha('1.2.3.4')).resolves.toBe(true);
  });

  it('records the first failure with a fifteen-minute TTL', async () => {
    redis.incr.mockResolvedValueOnce(1);
    await service.recordLoginFailure('1.2.3.4');
    expect(redis.incr).toHaveBeenCalledWith('login:captcha-failures:1.2.3.4');
    expect(redis.expire).toHaveBeenCalledWith('login:captcha-failures:1.2.3.4', 900);
  });

  it('clears failures after successful login', async () => {
    await service.clearLoginFailures('1.2.3.4');
    expect(redis.del).toHaveBeenCalledWith('login:captcha-failures:1.2.3.4');
  });
});
