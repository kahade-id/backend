import { Test } from '@nestjs/testing';
import { PublicController } from '../public.controller';
import { PublicService } from '../public.service';
import { WalletModeService } from '../../wallet-mode/wallet-mode.service';

describe('PublicController — wallet-status (kontrak kanonis)', () => {
  const publicService: any = {};
  const walletMode: any = { isWalletEnabled: jest.fn() };

  const build = async () => {
    const mod = await Test.createTestingModule({
      controllers: [PublicController],
      providers: [
        { provide: PublicService, useValue: publicService },
        { provide: WalletModeService, useValue: walletMode },
      ],
    }).compile();
    return mod.get(PublicController);
  };

  beforeEach(() => jest.clearAllMocks());

  it('GET /v1/public/wallet-status → { walletEnabled: false } saat kill-switch mati', async () => {
    walletMode.isWalletEnabled.mockReturnValue(false);
    const ctl = await build();
    expect(ctl.getWalletStatus()).toEqual({ walletEnabled: false });
  });

  it('GET /v1/public/wallet-status → { walletEnabled: true } saat wallet diizinkan', async () => {
    walletMode.isWalletEnabled.mockReturnValue(true);
    const ctl = await build();
    expect(ctl.getWalletStatus()).toEqual({ walletEnabled: true });
  });
});
