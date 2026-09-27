import type { PrismaService } from '../../../prisma/prisma.service';

/**
 * GAP-F (G401–G425): typed accessor untuk model moderasi baru.
 *
 * Model ReportModerationEvent / ReportAppeal / ReportCluster /
 * ReportClusterMember / ReportAssignment didefinisikan di fragment schema
 * (fixes/fragments/gap-F-A-schema.prisma) dan BELUM di-merge ke
 * prisma/schema.prisma — Prisma Client hasil generate belum mengenalnya.
 * Supaya `tsc` tetap lolos sebelum koordinator merge + `prisma generate`,
 * akses ke delegate baru dilewatkan interface ini (cast terkontrol di
 * `moderationDb()`). Setelah client di-regenerate, cast ini tetap valid
 * karena bentuknya mengikuti model fragment.
 *
 * JANGAN pakai `any` mentah di service — pakai `moderationDb(this.prisma)`.
 */

/** Nilai enum sebagai string agar tidak bergantung pada client hasil generate. */
export type ModerationEventActionValue =
  | 'REOPENED'
  | 'NOTE_ADDED'
  | 'APPEAL_FILED'
  | 'APPEAL_DECIDED'
  | 'RESTORED'
  | 'RESTRICTED'
  | 'TAKEDOWN'
  | 'ASSIGNED'
  | 'ESCALATED'
  | 'EXPORTED'
  | 'DISMISSED'
  | 'NO_ACTION'
  | 'UNDER_REVIEW';

export type ModerationReasonCodeValue =
  | 'SPAM'
  | 'HARASSMENT'
  | 'FRAUD_SUSPECTED'
  | 'PROHIBITED_ITEM'
  | 'MISLEADING'
  | 'IP_VIOLATION'
  | 'NUDITY'
  | 'OTHER';

/** Daftar nilai enum ModerationReasonCode (untuk validasi @IsIn sebelum client regenerate). */
export const MODERATION_REASON_CODES = [
  'SPAM',
  'HARASSMENT',
  'FRAUD_SUSPECTED',
  'PROHIBITED_ITEM',
  'MISLEADING',
  'IP_VIOLATION',
  'NUDITY',
  'OTHER',
] as const;

export type AppealStatusValue = 'PENDING' | 'APPROVED' | 'REJECTED';
export type AppellantTypeValue = 'OWNER' | 'REPORTER';

export interface ReportModerationEventRow {
  id: string;
  reportId: string;
  actorAdminId: string | null;
  action: ModerationEventActionValue;
  stateFrom: string | null;
  stateTo: string | null;
  reasonCode: ModerationReasonCodeValue | null;
  note: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ReportAppealRow {
  id: string;
  reportId: string;
  appellantType: AppellantTypeValue;
  appellantUserId: string;
  reason: string;
  newEvidence: unknown;
  status: AppealStatusValue;
  reviewerAdminId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReportClusterRow {
  id: string;
  showcaseId: string;
  reason: string;
  reportCount: number;
  createdAt: Date;
}

export interface ReportClusterMemberRow {
  id: string;
  clusterId: string;
  reportId: string;
  createdAt: Date;
}

export interface ReportAssignmentRow {
  id: string;
  reportId: string;
  assigneeAdminId: string;
  riskScore: number;
  slaDueAt: Date;
  escalated: boolean;
  assignedAt: Date;
  unassignedAt: Date | null;
  createdAt: Date;
}

/** Delegate Prisma minimal yang dipakai lifecycle moderasi. */
export interface ModerationDelegate<TRow> {
  create(args: { data: Record<string, unknown>; select?: Record<string, boolean> }): Promise<TRow>;
  createMany(args: { data: Record<string, unknown>[] }): Promise<{ count: number }>;
  findMany(args?: Record<string, unknown>): Promise<TRow[]>;
  findFirst(args?: Record<string, unknown>): Promise<TRow | null>;
  findUnique(args?: Record<string, unknown>): Promise<TRow | null>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<TRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface ModerationPrisma {
  reportModerationEvent: ModerationDelegate<ReportModerationEventRow>;
  reportAppeal: ModerationDelegate<ReportAppealRow>;
  reportCluster: ModerationDelegate<ReportClusterRow>;
  reportClusterMember: ModerationDelegate<ReportClusterMemberRow>;
  reportAssignment: ModerationDelegate<ReportAssignmentRow>;
}

/**
 * Cast terkontrol: PrismaService → PrismaService & ModerationPrisma.
 * Runtime valid setelah fragment schema di-merge + `prisma generate`.
 */
export function moderationDb(prisma: PrismaService): PrismaService & ModerationPrisma {
  return prisma as unknown as PrismaService & ModerationPrisma;
}
