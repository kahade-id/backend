import { DanaWebhookController } from './dana-webhook.controller';

/**
 * Controller webhook DANA: header respons X-TIMESTAMP (konvensi webhook DANA).
 */
describe('DanaWebhookController', () => {
  function makeController() {
    const settlement = { handleFinishNotify: jest.fn().mockResolvedValue({ responseCode: '2005600', responseMessage: 'Successful' }) };
    const disbursement = { handleDisbursNotify: jest.fn().mockResolvedValue({ responseCode: '2004300', responseMessage: 'Successful' }) };
    const controller = new DanaWebhookController(settlement as any, disbursement as any);
    const res = { setHeader: jest.fn() };
    const req = { rawBody: Buffer.from('{}'), path: '/v1/webhooks/dana/payment' } as any;
    return { controller, settlement, disbursement, res, req };
  }

  it('finishNotify menyetel header X-TIMESTAMP format Jakarta', async () => {
    const { controller, res, req } = makeController();
    await controller.finishNotify(req, {}, {}, res as any);
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-TIMESTAMP',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/),
    );
  });

  it('disbursNotify menyetel header X-TIMESTAMP format Jakarta', async () => {
    const { controller, res, req } = makeController();
    const disbReq = { ...req, path: '/v1/webhooks/dana/disbursement' };
    await controller.disbursNotify(disbReq, {}, {}, res as any);
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-TIMESTAMP',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/),
    );
  });
});
