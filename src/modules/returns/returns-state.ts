/**
 * GAP-D retur — state machine (G202).
 *
 * ReturnRequest punya status SENDIRI; transisi hanya boleh mengikuti peta
 * legal di bawah. Setiap perubahan status WAJIB lewat `transition()` yang
 * melempar BadRequestException berkode bila ilegal, dan selalu menulis
 * ReturnTimeline (audit G220).
 */
import { BadRequestException } from '@nestjs/common';
import * as ErrorCodes from '../../common/constants/error-codes';
import type { ReturnStatus } from './returns.types';

export const RETURN_INVALID_TRANSITION = 'RETURN_INVALID_TRANSITION';

const LEGAL_TRANSITIONS: Record<ReturnStatus, ReadonlySet<ReturnStatus>> = {
  REQUESTED: new Set(['SELLER_REVIEW', 'APPROVED', 'REJECTED', 'CLARIFICATION_NEEDED', 'CANCELLED', 'EXPIRED', 'ESCALATED']),
  SELLER_REVIEW: new Set(['APPROVED', 'REJECTED', 'CLARIFICATION_NEEDED', 'EXPIRED', 'ESCALATED']),
  CLARIFICATION_NEEDED: new Set(['SELLER_REVIEW', 'CANCELLED', 'EXPIRED', 'ESCALATED']),
  APPROVED: new Set(['RETURN_SHIPPING', 'RESOLVED_REFUND', 'RESOLVED_EXCHANGE', 'RESOLVED_REPAIR', 'ESCALATED', 'CANCELLED']),
  REJECTED: new Set(['ESCALATED']),
  RETURN_SHIPPING: new Set(['RECEIVED', 'ESCALATED', 'CANCELLED']),
  RECEIVED: new Set(['RESOLVED_REFUND', 'RESOLVED_EXCHANGE', 'RESOLVED_REPAIR', 'ESCALATED']),
  RESOLVED_REFUND: new Set([]),
  RESOLVED_EXCHANGE: new Set([]),
  RESOLVED_REPAIR: new Set([]),
  ESCALATED: new Set([]),
  CANCELLED: new Set([]),
  EXPIRED: new Set([]),
};

export function isLegalReturnTransition(from: ReturnStatus, to: ReturnStatus): boolean {
  return LEGAL_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertLegalReturnTransition(from: ReturnStatus, to: ReturnStatus): void {
  if (!isLegalReturnTransition(from, to)) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      message: `Transisi status retur tidak valid: ${from} → ${to}`,
      details: { transitionCode: RETURN_INVALID_TRANSITION, from, to },
    });
  }
}

/** Status yang masih dianggap "case aktif" untuk cegah pengajuan ganda (G218). */
export const ACTIVE_RETURN_STATUSES: ReadonlySet<ReturnStatus> = new Set([
  'REQUESTED',
  'SELLER_REVIEW',
  'CLARIFICATION_NEEDED',
  'APPROVED',
  'RETURN_SHIPPING',
  'RECEIVED',
]);
