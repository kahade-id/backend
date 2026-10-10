import { ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { AdminShowcaseCommentsController } from './admin-showcase-comments.controller';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import * as ErrorCodes from '../../../common/constants/error-codes';

/**
 * ADM-09 (audit etalase 2026-10-10): PATCH /admin/showcase/comments/:id
 * action=delete wajib X-Step-Up-Token (aksi `showcase-comment.delete`,
 * targetId = id komentar). hide/unhide tidak memerlukan step-up.
 */
describe('AdminShowcaseCommentsController — step-up untuk delete (ADM-09)', () => {
  const admin = { sub: 'adm-db-1', adminId: 'ADM-001', role: 'SUPER_ADMIN' } as unknown as AdminJwtPayload;

  function make() {
    const showcaseService = { adminModerateComment: jest.fn().mockResolvedValue({ ok: true }) };
    const stepUp = {
      consumeStepUpToken: jest.fn(async (raw: string | undefined) => {
        if (!raw) {
          throw new ForbiddenException({ code: ErrorCodes.STEP_UP_REQUIRED, message: 'required' });
        }
      }),
    };
    const ctrl = new AdminShowcaseCommentsController(showcaseService as any, stepUp as any);
    return { ctrl, showcaseService, stepUp };
  }

  function req(headers: Record<string, string> = {}): Request {
    return { headers, ip: '10.0.0.1' } as unknown as Request;
  }

  it('delete tanpa token → 403 STEP_UP_REQUIRED, service TIDAK dipanggil', async () => {
    const { ctrl, showcaseService } = make();
    await expect(ctrl.moderate('c1', { action: 'delete', reason: 'spam' }, admin, req())).rejects.toMatchObject({
      response: { code: ErrorCodes.STEP_UP_REQUIRED },
    });
    expect(showcaseService.adminModerateComment).not.toHaveBeenCalled();
  });

  it('delete dengan token → token dihanguskan untuk aksi+target yang benar, lalu service dipanggil', async () => {
    const { ctrl, showcaseService, stepUp } = make();
    await ctrl.moderate('c1', { action: 'delete', reason: 'spam' }, admin, req({ 'x-step-up-token': 'tok-1' }));
    expect(stepUp.consumeStepUpToken).toHaveBeenCalledWith('tok-1', {
      adminId: 'adm-db-1',
      action: 'showcase-comment.delete',
      targetId: 'c1',
    });
    expect(showcaseService.adminModerateComment).toHaveBeenCalledWith('adm-db-1', 'c1', 'delete', 'spam', '10.0.0.1');
  });

  it('hide/unhide tidak memerlukan step-up', async () => {
    const { ctrl, showcaseService, stepUp } = make();
    await ctrl.moderate('c1', { action: 'hide', reason: 'SPAM' }, admin, req());
    await ctrl.moderate('c1', { action: 'unhide' }, admin, req());
    expect(stepUp.consumeStepUpToken).not.toHaveBeenCalled();
    expect(showcaseService.adminModerateComment).toHaveBeenCalledTimes(2);
  });
});
