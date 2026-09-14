const fs = require('fs');
const path = require('path');
const schema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
const enumRegex = /enum\s+(\w+)\s*\{([^}]+)\}/g;
let match;
const enums = [];
while ((match = enumRegex.exec(schema)) !== null) {
  const name = match[1];
  const body = match[2];
  const values = body.split('\n').map(l=>l.trim()).filter(l=>l && !l.startsWith('//')).map(l=>l.split(/\s+/)[0]).filter(Boolean);
  enums.push({ name, values });
}
let dts = `/* Mock Prisma Client for offline typecheck */\nimport * as runtime from '@prisma/client/runtime/library'\n\nexport declare const PrismaClient: any\n\nexport declare class PrismaClient<TOptions = any, TLog = any, TExtArgs extends runtime.Types.Extensions.InternalArgs = any> {\n  constructor(options?: any)\n  $connect(): Promise<void>\n  $disconnect(): Promise<void>\n  $transaction<T>(fn: (tx: any) => Promise<T>, options?: any): Promise<T>\n  $transaction<T>(operations: Promise<T>[]): Promise<T[]>\n  $queryRaw<T = unknown>(query: any, ...values: any[]): Promise<T>\n  $executeRaw(query: any, ...values: any[]): Promise<number>\n  $extends: any\n  [key: string]: any\n}\n\nexport namespace Prisma {\n  export type TransactionClient = any\n  export type TransactionIsolationLevel = 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable'\n  export const TransactionIsolationLevel: {\n    ReadUncommitted: 'ReadUncommitted',\n    ReadCommitted: 'ReadCommitted',\n    RepeatableRead: 'RepeatableRead',\n    Serializable: 'Serializable'\n  }\n  export class PrismaClientKnownRequestError extends Error { code: string; meta?: any }\n  export class PrismaClientUnknownRequestError extends Error {}\n  export class PrismaClientInitializationError extends Error {}\n  export class PrismaClientRustPanicError extends Error {}\n  export const DbNull: any\n  export const JsonNull: any\n  export type InputJsonValue = any\n  export type JsonValue = any\n  export type NullableJsonInput = any\n  export const sql: any\n  export const empty: any\n  export const join: any\n  export const raw: any\n  export type OrderWhereInput = any\n  export type OrderOrderByWithRelationInput = any\n  export type BusinessVerificationWhereInput = any\n  export type CampaignWhereInput = any\n  export type CampaignUpdateInput = any\n  export type WalletTransactionWhereInput = any\n  export type RatingWhereInput = any\n  export type ReferralCodeWhereInput = any\n  export type UserReportWhereInput = any\n  export type EnumReportStatusFilter = any\n  export type EnumReportCategoryFilter = any\n  export type EnumDisputeStatusFilter = any\n  export type SubscriptionWhereInput = any\n  export type EnumSubscriptionStatusFilter = any\n  export type EnumSubscriptionPlanFilter = any\n  export type SupportTicketWhereInput = any\n  export type EnumKycStatusFilter = any\n  export type MembershipRankHistoryWhereInput = any\n  export type UserWhereInput = any\n  export type NotificationWhereInput = any\n  export type VoucherWhereInput = any\n  export type DisputeWhereInput = any\n  export type OrderStatusHistoryWhereInput = any\n  export type ChatRoomWhereInput = any\n  export type ChatMessageWhereInput = any\n  export type BankAccountWhereInput = any\n  export type PaymentTransactionWhereInput = any\n  export type WalletWhereInput = any\n  export type DisputeEvidenceWhereInput = any\n  export type DisputeDecisionWhereInput = any\n  export type DisputeMessageWhereInput = any\n  export type ProfileQuestionWhereInput = any\n  export type ShowcaseWhereInput = any\n  export type UserShowcaseWhereInput = any\n  export type FaqItemWhereInput = any\n  export type FaqCategoryWhereInput = any\n  export type TransactionTemplateWhereInput = any\n  export type SupportTicketReplyWhereInput = any\n  export type ReferralRelationWhereInput = any\n  export type ReferralRewardWhereInput = any\n}\n\n`;

for (const e of enums) {
  dts += `export const ${e.name}: {\n`;
  for (const v of e.values) {
    dts += `  ${v}: '${v}',\n`;
  }
  dts += `};\n`;
  dts += `export type ${e.name} = (typeof ${e.name})[keyof typeof ${e.name}];\n\n`;
}

// models as any
const models = ['User','Order','Voucher','Campaign','Wallet','WalletTransaction','PaymentTransaction','ChatRoom','ChatMessage','Dispute','Rating','Notification','BankAccount','KycRequest','BusinessVerification','Subscription','ReferralCode','ReferralRelation','ReferralReward','OrderExtensionRequest','OrderStatusHistory','DisputeEvidence','DisputeDecision','DisputeMessage','DisputeCall','ProfileQuestion','UserShowcase','ShowcaseImage','ShowcaseLike','ShowcaseComment','FaqCategory','FaqItem','TransactionTemplate','SupportTicket','SupportTicketReply','UserReport','BlockList','UserFavorite','UserSavedProfile','Follow','UserLink','Badge','UserBadge','PasswordHistory','AdminUser','AdminAuditLog','SystemConfig','WebhookLog','AuditLog','OrderLink','DeliveryProof','RatingReply','ProfileQuestionComment','ProfileQuestionUpvote','ChatMessageReaction','ChatMessageEdit','ChatRoomMember','ChatModerationEvent','ChatAttachment','MutualResolutionProposal','ScheduledWithdrawal','IdempotencyRecord','WalletFavoriteRecipient','UserSession','UserDevice','TwoFactorAuth','OtpCode','NotificationPreference','VoucherUsage','MembershipRankHistory'];
for (const m of models) {
  dts += `export type ${m} = any\n`;
}

fs.writeFileSync(path.join(__dirname, '../node_modules/.prisma/client/default.d.ts'), dts);
console.log('mock client v2 written');
