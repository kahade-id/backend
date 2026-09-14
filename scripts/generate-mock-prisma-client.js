const fs = require('fs');
const path = require('path');
const schema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
const enumRegex = /enum\s+(\w+)\s*\{([^}]+)\}/g;
let match;
const enums = [];
while ((match = enumRegex.exec(schema)) !== null) {
  const name = match[1];
  const body = match[2];
  const values = body.split('\n').map(l=>l.trim()).filter(l=>l && !l.startsWith('//')).map(l=>l.split(/\s+/)[0]);
  enums.push({ name, values });
}
let dts = `/* Mock Prisma Client for offline typecheck */\nimport * as runtime from '@prisma/client/runtime/library'\n\nexport declare const PrismaClient: any\n\nexport declare class PrismaClient<TOptions = any, TLog = any, TExtArgs extends runtime.Types.Extensions.InternalArgs = any> {\n  constructor(options?: any)\n  $connect(): Promise<void>\n  $disconnect(): Promise<void>\n  $transaction<T>(fn: (tx: any) => Promise<T>, options?: any): Promise<T>\n  $transaction<T>(operations: Promise<T>[]): Promise<T[]>\n  $queryRaw<T = unknown>(query: any, ...values: any[]): Promise<T>\n  $executeRaw(query: any, ...values: any[]): Promise<number>\n  $extends: any\n  [key: string]: any\n}\n\nexport namespace Prisma {\n  export type TransactionClient = any\n  export type TransactionIsolationLevel = 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable'\n  export const TransactionIsolationLevel: {\n    ReadUncommitted: 'ReadUncommitted',\n    ReadCommitted: 'ReadCommitted',\n    RepeatableRead: 'RepeatableRead',\n    Serializable: 'Serializable'\n  }\n  export class PrismaClientKnownRequestError extends Error { code: string; meta?: any }\n  export class PrismaClientUnknownRequestError extends Error {}\n  export class PrismaClientInitializationError extends Error {}\n  export class PrismaClientRustPanicError extends Error {}\n  export const DbNull: any\n  export const JsonNull: any\n  export type InputJsonValue = any\n  export type JsonValue = any\n  export type NullableJsonInput = any\n  export type OrderWhereInput = any\n  export type OrderOrderByWithRelationInput = any\n  export type BusinessVerificationWhereInput = any\n  export type CampaignWhereInput = any\n  export type CampaignUpdateInput = any\n  export type WalletTransactionWhereInput = any\n  export type RatingWhereInput = any\n  export type ReferralCodeWhereInput = any\n  export type UserReportWhereInput = any\n  export type EnumReportStatusFilter = any\n  export type EnumReportCategoryFilter = any\n  export type SubscriptionWhereInput = any\n  export type EnumSubscriptionStatusFilter = any\n  export type EnumSubscriptionPlanFilter = any\n  export type SupportTicketWhereInput = any\n  export type EnumKycStatusFilter = any\n  export type MembershipRankHistoryWhereInput = any\n  export type UserWhereInput = any\n  export type NotificationWhereInput = any\n  export type VoucherWhereInput = any\n  export type DisputeWhereInput = any\n  export type OrderStatusHistoryWhereInput = any\n  export type ChatRoomWhereInput = any\n  export type ChatMessageWhereInput = any\n  export type BankAccountWhereInput = any\n  export type PaymentTransactionWhereInput = any\n  export type WalletWhereInput = any\n  export type DisputeEvidenceWhereInput = any\n  export type DisputeDecisionWhereInput = any\n  export type DisputeMessageWhereInput = any\n  export type ProfileQuestionWhereInput = any\n  export type ShowcaseWhereInput = any\n  export type UserShowcaseWhereInput = any\n  export type FaqItemWhereInput = any\n  export type FaqCategoryWhereInput = any\n  export type TransactionTemplateWhereInput = any\n  export type SupportTicketReplyWhereInput = any\n  export type ReferralRelationWhereInput = any\n  export type ReferralRewardWhereInput = any\n  export type SubscriptionPlan = any\n  export type SubscriptionStatus = any\n  export type OrderStatus = any\n  export type OrderType = any\n  export type FeeResponsibility = any\n  export type WalletTransactionType = any\n  export type WalletTransactionStatus = any\n  export type PaymentStatus = any\n  export type PaymentMethod = any\n  export type PaymentProvider = any\n  export type PaymentPurpose = any\n  export type WithdrawStatus = any\n  export type DisputeStatus = any\n  export type DisputeInitiator = any\n  export type DisputeDecisionType = any\n  export type MembershipRank = any\n  export type OtpType = any\n  export type OtpMethod = any\n  export type NotificationCategory = any\n  export type NotificationChannel = any\n  export type NotificationType = any\n  export type AdminRole = any\n  export type SupportTicketStatus = any\n  export type SupportTicketCategory = any\n  export type SupportTicketSenderType = any\n  export type ReportCategory = any\n  export type ReportStatus = any\n  export type BankCode = any\n  export type ChatMessageType = any\n  export type ChatRoomType = any\n  export type ChatRoomStatus = any\n  export type ChatRoomMemberRole = any\n  export type ChatModerationKind = any\n  export type ChatModerationSeverity = any\n  export type ChatModerationAction = any\n  export type ChatModerationStatus = any\n  export type DeadlineExtensionStatus = any\n  export type VoucherType = any\n  export type AuditAction = any\n  export type OrderLinkStatus = any\n  export type DeliveryProofStatus = any\n  export type CampaignType = any\n  export type CampaignStatus = any\n  export type UserAuditAction = any\n  export type ActorType = any\n  export type UserRole = any\n  export type VoucherApplicability = any\n  export type SystemConfigDataType = any\n  export type ShowcaseVisibility = any\n  export type ContentHiddenReason = any\n  export type DisputeCallStatus = any\n  export type IdempotencyRecordStatus = any\n  export type KycStatus = any\n  export type BusinessVerificationStatus = any\n  export type OrderCancelReason = any\n  export type Gender = any\n  export type UserAccountType = any\n}\n\n`;

for (const e of enums) {
  dts += `export enum ${e.name} {\n`;
  for (const v of e.values) {
    if (!v) continue;
    dts += `  ${v} = \"${v}\",\n`;
  }
  dts += `}\n\n`;
}

// Also export all models as any
dts += `export type User = any\n`;
dts += `export type Order = any\n`;
dts += `export type Voucher = any\n`;
dts += `export type Campaign = any\n`;
dts += `export type Wallet = any\n`;
dts += `export type WalletTransaction = any\n`;
dts += `export type PaymentTransaction = any\n`;
dts += `export type ChatRoom = any\n`;
dts += `export type ChatMessage = any\n`;
dts += `export type Dispute = any\n`;
dts += `export type Rating = any\n`;
dts += `export type Notification = any\n`;
dts += `export type BankAccount = any\n`;
dts += `export type KycRequest = any\n`;
dts += `export type BusinessVerification = any\n`;
dts += `export type Subscription = any\n`;
dts += `export type ReferralCode = any\n`;
dts += `export type ReferralRelation = any\n`;
dts += `export type ReferralReward = any\n`;
dts += `export type OrderExtensionRequest = any\n`;
dts += `export type OrderStatusHistory = any\n`;
dts += `export type DisputeEvidence = any\n`;
dts += `export type DisputeDecision = any\n`;
dts += `export type DisputeMessage = any\n`;
dts += `export type DisputeCall = any\n`;
dts += `export type ProfileQuestion = any\n`;
dts += `export type UserShowcase = any\n`;
dts += `export type ShowcaseImage = any\n`;
dts += `export type ShowcaseLike = any\n`;
dts += `export type ShowcaseComment = any\n`;
dts += `export type FaqCategory = any\n`;
dts += `export type FaqItem = any\n`;
dts += `export type TransactionTemplate = any\n`;
dts += `export type SupportTicket = any\n`;
dts += `export type SupportTicketReply = any\n`;
dts += `export type UserReport = any\n`;
dts += `export type BlockList = any\n`;
dts += `export type UserFavorite = any\n`;
dts += `export type UserSavedProfile = any\n`;
dts += `export type Follow = any\n`;
dts += `export type UserLink = any\n`;
dts += `export type Badge = any\n`;
dts += `export type UserBadge = any\n`;
dts += `export type PasswordHistory = any\n`;
dts += `export type AdminUser = any\n`;
dts += `export type AdminAuditLog = any\n`;
dts += `export type SystemConfig = any\n`;
dts += `export type WebhookLog = any\n`;
dts += `export type AuditLog = any\n`;
dts += `export type OrderLink = any\n`;
dts += `export type DeliveryProof = any\n`;
dts += `export type RatingReply = any\n`;
dts += `export type ProfileQuestionComment = any\n`;
dts += `export type ProfileQuestionUpvote = any\n`;
dts += `export type ChatMessageReaction = any\n`;
dts += `export type ChatMessageEdit = any\n`;
dts += `export type ChatRoomMember = any\n`;
dts += `export type ChatModerationEvent = any\n`;
dts += `export type ChatAttachment = any\n`;
dts += `export type MutualResolutionProposal = any\n`;
dts += `export type ScheduledWithdrawal = any\n`;
dts += `export type IdempotencyRecord = any\n`;
dts += `export type WalletFavoriteRecipient = any\n`;
dts += `export type UserSession = any\n`;
dts += `export type UserDevice = any\n`;
dts += `export type TwoFactorAuth = any\n`;
dts += `export type OtpCode = any\n`;
dts += `export type NotificationPreference = any\n`;
dts += `export type VoucherUsage = any\n`;
dts += `export type MembershipRankHistory = any\n`;
dts += `export type OrderLinkStatus = any\n`;

fs.writeFileSync(path.join(__dirname, '../node_modules/.prisma/client/default.d.ts'), dts);
console.log('mock client written');
