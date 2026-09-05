import { DeepLinksController } from '../deep-links.controller';

describe('DeepLinksController', () => {
  const usersService = { getPublicProfile: jest.fn() };
  const orderLinksService = { getLinkByToken: jest.fn() };
  let controller: DeepLinksController;
  let response: { status: jest.Mock; type: jest.Mock; set: jest.Mock; send: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new DeepLinksController(usersService as never, orderLinksService as never);
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
});
