import { DeepLinksController } from '../deep-links.controller';

describe('DeepLinksController', () => {
  const usersService = { getPublicProfile: jest.fn() };
  const orderLinksService = { getLinkByToken: jest.fn() };
  // Section 3: halaman share showcase.
  const showcaseService = { getSharePayload: jest.fn() };
  let controller: DeepLinksController;
  let response: { status: jest.Mock; type: jest.Mock; set: jest.Mock; send: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new DeepLinksController(usersService as never, orderLinksService as never, showcaseService as never);
    response = {
      status: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };
  });

  it('renders public profile metadata and an app fallback button', async () => {
    usersService.getPublicProfile.mockResolvedValue({ username: 'alice', fullName: 'Alice', bio: 'Escrow seller' });
    await controller.profile('alice', response as never);
    const html = String(response.send.mock.calls[0][0]);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(html).toContain('Alice');
    expect(html).toContain('kahade-frontend://u/alice');
    expect(html).toContain('Buka di aplikasi Kahade');
  });

  it('keeps expired or unavailable order links browser-safe', async () => {
    orderLinksService.getLinkByToken.mockRejectedValue(new Error('expired'));
    await controller.orderLink('token-1', response as never);
    const html = String(response.send.mock.calls[0][0]);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(html).toContain('kahade-frontend://o-l/token-1');
    expect(html).toContain('sudah kedaluwarsa');
  });

  it('rejects malformed public identifiers before querying services', async () => {
    await controller.profile('../alice', response as never);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(usersService.getPublicProfile).not.toHaveBeenCalled();
    expect(String(response.send.mock.calls[0][0])).not.toContain('../alice');

    jest.clearAllMocks();
    await controller.orderLink('token/with/slash', response as never);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(orderLinksService.getLinkByToken).not.toHaveBeenCalled();
  });

  it('rejects malformed order and notification IDs', () => {
    controller.order('order with spaces', response as never);
    expect(response.status).toHaveBeenCalledWith(404);
    jest.clearAllMocks();
    controller.notification('', response as never);
    expect(response.status).toHaveBeenCalledWith(404);
  });

  // Section 2: profil publik sekarang mengembalikan bagian `identity`.
  it('reads the nested identity section of the redesigned profile payload', async () => {
    usersService.getPublicProfile.mockResolvedValue({
      identity: { nickname: 'Alice Wijaya', username: 'alice', bio: 'Menerima komisi ilustrasi' },
      fullName: 'ignored-flat-alias',
    });
    await controller.profile('alice', response as never);
    const html = String(response.send.mock.calls[0][0]);
    expect(html).toContain('Alice Wijaya');
    expect(html).toContain('Menerima komisi ilustrasi');
    expect(html).not.toContain('ignored-flat-alias');
  });

  // Section 6: 404 (profil privat) dan 403 (block-list) tidak boleh bocor.
  it('renders the same neutral page for a private profile and a blocked viewer', async () => {
    usersService.getPublicProfile.mockRejectedValue({ response: { code: 'USER_NOT_FOUND' } });
    await controller.profile('alice', response as never);
    const privateHtml = String(response.send.mock.calls[0][0]);

    jest.clearAllMocks();
    usersService.getPublicProfile.mockRejectedValue({ response: { code: 'USER_BLOCKED' } });
    await controller.profile('alice', response as never);
    const blockedHtml = String(response.send.mock.calls[0][0]);

    expect(privateHtml).toContain('belum dapat dimuat');
    expect(privateHtml).toBe(blockedHtml);
    expect(blockedHtml).not.toContain('USER_BLOCKED');
  });

  describe('showcase share page (Section 3)', () => {
    it('renders showcase metadata and the app deep link', async () => {
      showcaseService.getSharePayload.mockResolvedValue({
        title: 'Ilustrasi karakter',
        description: 'Komisi ilustrasi full body',
        priceLabel: 'Rp 150000 - Rp 350000',
        authorUsername: 'seller',
      });
      await controller.showcase('cshowcase000000000000001', response as never);
      const html = String(response.send.mock.calls[0][0]);
      expect(response.status).toHaveBeenCalledWith(200);
      expect(html).toContain('Ilustrasi karakter');
      expect(html).toContain('Rp 150000 - Rp 350000');
      expect(html).toContain('@seller');
      expect(html).toContain('kahade-frontend://showcase/cshowcase000000000000001');
    });

    it('does not leak PRIVATE, deleted or blocked items', async () => {
      showcaseService.getSharePayload.mockRejectedValue({ response: { code: 'SHOWCASE_NOT_FOUND' } });
      await controller.showcase('cshowcase000000000000001', response as never);
      const html = String(response.send.mock.calls[0][0]);
      expect(response.status).toHaveBeenCalledWith(200);
      expect(html).toContain('privat, sudah dihapus, atau tidak tersedia');
      expect(html).not.toContain('SHOWCASE_NOT_FOUND');
    });

    it('rejects a malformed showcase id before querying the service', async () => {
      await controller.showcase('../etc/passwd', response as never);
      expect(response.status).toHaveBeenCalledWith(404);
      expect(showcaseService.getSharePayload).not.toHaveBeenCalled();
      expect(String(response.send.mock.calls[0][0])).not.toContain('../etc/passwd');
    });
  });
});
