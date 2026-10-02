import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminStepUpService } from '../../modules/admin/auth/step-up.service';
import {
  REQUIRE_STEP_UP_KEY,
  RequireStepUpOptions,
} from '../decorators/require-step-up.decorator';
import * as ErrorCodes from '../constants/error-codes';

/**
 * SEC-503: guard step-up re-auth server-side.
 *
 * Membaca header `X-Step-Up-Token`, memvalidasi token terhadap
 * AdminStepUpToken (hash cocok, milik admin pemanggil, belum kedaluwarsa,
 * belum dipakai, action & targetId cocok), lalu menghanguskan token secara
 * atomik (single-use: updateMany where usedAt null).
 *
 * Gagal → 403 dengan kode STEP_UP_REQUIRED | STEP_UP_INVALID |
 * STEP_UP_EXPIRED | STEP_UP_MISMATCH.
 *
 * CATATAN URUTAN GUARD: pasang JwtAdminGuard (+ AdminRolesGuard) di
 * class-level dan StepUpGuard di method-level — guard class-level selalu
 * berjalan lebih dulu sehingga `request.admin` sudah terisi.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly stepUp: AdminStepUpService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.getAllAndOverride<RequireStepUpOptions>(
      REQUIRE_STEP_UP_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Endpoint tanpa @RequireStepUp → lolos (guard no-op).
    if (!opts) return true;

    const req = context.switchToHttp().getRequest();
    const admin = req.admin as { sub?: string } | undefined;
    if (!admin?.sub) {
      throw new UnauthorizedException({
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Admin authentication required before step-up check',
      });
    }

    const raw = req.headers['x-step-up-token'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (!token || typeof token !== 'string' || token.length === 0) {
      throw new ForbiddenException({
        code: ErrorCodes.STEP_UP_REQUIRED,
        message:
          'Step-up re-authentication required. Obtain a token via POST /v1/admin/auth/step-up and send it in the X-Step-Up-Token header.',
      });
    }

    const targetId =
      opts.targetParam && req.params
        ? (req.params[opts.targetParam] as string | undefined)
        : undefined;

    await this.stepUp.consumeStepUpToken(token, {
      adminId: admin.sub,
      action: opts.action,
      targetId,
    });
    return true;
  }
}
