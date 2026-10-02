import { SetMetadata } from '@nestjs/common';

export const REQUIRE_STEP_UP_KEY = 'requireStepUp';

export interface RequireStepUpOptions {
  /**
   * Aksi yang diikat ke token step-up. Harus sama persis dengan `action`
   * yang dipakai saat meminta token via POST /v1/admin/auth/step-up.
   */
  action: string;
  /**
   * Nama route param yang diikat sebagai targetId (mis. 'disputeId').
   * Bila token step-up punya targetId, nilainya harus sama dengan param ini.
   */
  targetParam?: string;
}

/**
 * SEC-503: menandai endpoint admin yang WAJIB dilampiri bukti step-up
 * server-side (header `X-Step-Up-Token`). StepUpGuard memvalidasi +
 * menghanguskan token secara atomik (sekali pakai).
 *
 * Prasyarat: JwtAdminGuard harus berjalan lebih dulu (class-level
 * @UseGuards) agar `request.admin` terisi.
 */
export const RequireStepUp = (
  action: string,
  targetParam?: string,
): ReturnType<typeof SetMetadata> =>
  SetMetadata(REQUIRE_STEP_UP_KEY, { action, targetParam } satisfies RequireStepUpOptions);
