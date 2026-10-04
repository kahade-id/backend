import { Injectable } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * SYS-C-105 (audit sistemik ronde 3, 2026-10-03): bahasa copy notifikasi
 * ditentukan preferensi user, BUKAN jalur kode.
 *
 * Sebelumnya 50+ call-site `prisma.notification.create` menulis
 * title/body hardcoded dalam bahasa pilihan penulis kode — user berbahasa
 * Inggris menerima notifikasi Indonesia dan sebaliknya, acak tergantung
 * fitur. `getUserLanguage()` sudah ada di NotificationsService tetapi NOL
 * pemanggil.
 *
 * Pola kanonis baru:
 *   const lang = await resolveNotificationLanguage(this.prisma, userId);
 *   const copy = renderNotificationCopy(NotificationType.X, lang, { amount: formatSen(x) });
 *   await this.prisma.notification.create({ data: { ..., title: copy.title, body: copy.body } });
 *
 * Atau via injectable: `this.notificationCopy.getCopy(userId, type, params)`.
 */

export type NotificationLang = 'id' | 'en';

export interface NotificationCopyTemplate {
  title: string;
  body: string;
}

export type NotificationCopyParams = Record<string, string | number>;

/**
 * Template per NotificationType × ('id' | 'en').
 * Placeholder `{nama}` diisi dari params via renderNotificationCopy().
 * Semua nominal uang HARUS sudah diformat pemanggil dengan formatIdr/formatSen
 * (helper kanonis SYS-C-101/102) sebelum dimasukkan ke params.
 */
export const NOTIFICATION_COPY: Record<
  NotificationType,
  Record<NotificationLang, NotificationCopyTemplate>
> = {
  // ------------------------------------------------------------------ ORDER
  [NotificationType.ORDER_NEW]: {
    id: {
      title: 'Pesanan baru',
      body: '{creatorName} membuat pesanan "{orderTitle}" senilai {amount}. Mohon konfirmasi.',
    },
    en: {
      title: 'New order',
      body: '{creatorName} created a new order "{orderTitle}" worth {amount}. Please confirm.',
    },
  },
  [NotificationType.ORDER_ACCEPTED]: {
    id: {
      title: 'Pesanan diterima',
      body: 'Pesanan "{orderTitle}" telah diterima penjual. Silakan lanjutkan ke pembayaran.',
    },
    en: {
      title: 'Order accepted',
      body: 'Order "{orderTitle}" has been accepted by the seller. Please proceed to payment.',
    },
  },
  [NotificationType.ORDER_REJECTED]: {
    id: {
      title: 'Pesanan ditolak',
      body: 'Pesanan "{orderTitle}" ditolak penjual.{reason}',
    },
    en: {
      title: 'Order rejected',
      body: 'Order "{orderTitle}" was rejected by the seller.{reason}',
    },
  },
  [NotificationType.ORDER_CANCELLED_TIMEOUT]: {
    id: {
      title: 'Pesanan dibatalkan otomatis',
      body: 'Pesanan "{orderTitle}" dibatalkan otomatis karena melewati batas waktu.',
    },
    en: {
      title: 'Order auto-cancelled',
      body: 'Order "{orderTitle}" was automatically cancelled because the time limit was exceeded.',
    },
  },
  [NotificationType.ORDER_CANCELLED]: {
    id: {
      title: 'Pesanan dibatalkan',
      body: 'Pesanan "{orderTitle}" telah dibatalkan.{reason}',
    },
    en: {
      title: 'Order cancelled',
      body: 'Order "{orderTitle}" has been cancelled.{reason}',
    },
  },
  [NotificationType.ORDER_PAYMENT_RECEIVED]: {
    id: {
      title: 'Pembayaran diterima',
      body: 'Pembayaran {amount} untuk pesanan "{orderTitle}" telah diterima dan ditahan di escrow Kahade.',
    },
    en: {
      title: 'Payment received',
      body: 'Payment of {amount} for order "{orderTitle}" has been received and is held in Kahade escrow.',
    },
  },
  [NotificationType.ORDER_SHIPPED]: {
    id: {
      title: 'Pesanan dikirim',
      body: 'Penjual telah mengirim pesanan "{orderTitle}".{tracking}',
    },
    en: {
      title: 'Order shipped',
      body: 'The seller has shipped order "{orderTitle}".{tracking}',
    },
  },
  [NotificationType.ORDER_DEADLINE_REMINDER]: {
    id: {
      title: 'Pengingat batas waktu pesanan',
      body: 'Pesanan "{orderTitle}" mendekati batas waktu ({deadline}). Segera selesaikan langkah Anda.',
    },
    en: {
      title: 'Order deadline reminder',
      body: 'Order "{orderTitle}" is approaching its deadline ({deadline}). Please complete your step soon.',
    },
  },
  [NotificationType.ORDER_EXTENSION_REQUESTED]: {
    id: {
      title: 'Permintaan perpanjangan waktu',
      body: '{requesterName} meminta perpanjangan waktu untuk pesanan "{orderTitle}".',
    },
    en: {
      title: 'Extension requested',
      body: '{requesterName} requested a deadline extension for order "{orderTitle}".',
    },
  },
  [NotificationType.ORDER_EXTENSION_APPROVED]: {
    id: {
      title: 'Perpanjangan disetujui',
      body: 'Permintaan perpanjangan waktu pesanan "{orderTitle}" disetujui. Batas baru: {deadline}.',
    },
    en: {
      title: 'Extension approved',
      body: 'The deadline extension request for order "{orderTitle}" was approved. New deadline: {deadline}.',
    },
  },
  [NotificationType.ORDER_EXTENSION_REJECTED]: {
    id: {
      title: 'Perpanjangan ditolak',
      body: 'Permintaan perpanjangan waktu pesanan "{orderTitle}" ditolak.',
    },
    en: {
      title: 'Extension rejected',
      body: 'The deadline extension request for order "{orderTitle}" was rejected.',
    },
  },
  [NotificationType.ORDER_COMPLETED]: {
    id: {
      title: 'Pesanan selesai',
      body: 'Pesanan "{orderTitle}" selesai. {amount} telah dikreditkan ke wallet Anda.',
    },
    en: {
      title: 'Order completed',
      body: 'Order "{orderTitle}" completed. {amount} has been credited to your wallet.',
    },
  },
  [NotificationType.ORDER_AUTOCOMPLETED]: {
    id: {
      title: 'Pesanan selesai otomatis',
      body: 'Pesanan "{orderTitle}" diselesaikan otomatis setelah melewati masa tenggang.',
    },
    en: {
      title: 'Order auto-completed',
      body: 'Order "{orderTitle}" was automatically completed after the grace period.',
    },
  },
  [NotificationType.ORDER_DELIVERED]: {
    id: {
      title: 'Segera Review Bukti Pengiriman',
      body: 'Batas waktu pesanan "{orderTitle}" sudah lewat tetapi Anda belum me-review bukti pengiriman. Anda memiliki {hours} jam lagi sebelum pesanan diselesaikan otomatis.',
    },
    en: {
      title: 'Review Delivery Proof Soon',
      body: 'The deadline for order "{orderTitle}" has passed but you have not reviewed the delivery proof yet. You have {hours} more hours before the order is auto-completed.',
    },
  },
  // ---------------------------------------------------------------- DISPUTE
  [NotificationType.DISPUTE_SUBMITTED]: {
    id: {
      title: 'Sengketa diajukan',
      body: '{proposer} mengajukan sengketa untuk pesanan "{orderTitle}".{detail}',
    },
    en: {
      title: 'Dispute filed',
      body: '{proposer} filed a dispute for order "{orderTitle}".{detail}',
    },
  },
  [NotificationType.DISPUTE_ADMIN_JOINED]: {
    id: {
      title: 'Admin bergabung dalam sengketa',
      body: 'Tim Kahade telah bergabung dalam sengketa pesanan "{orderTitle}" untuk membantu mediasi.',
    },
    en: {
      title: 'Admin joined the dispute',
      body: 'The Kahade team has joined the dispute for order "{orderTitle}" to help mediate.',
    },
  },
  [NotificationType.DISPUTE_MESSAGE_RECEIVED]: {
    id: {
      title: 'Pesan baru dalam sengketa',
      body: '{senderName}: {preview}',
    },
    en: {
      title: 'New dispute message',
      body: '{senderName}: {preview}',
    },
  },
  [NotificationType.DISPUTE_ESCALATION_SLA_WARNING]: {
    id: {
      title: 'Peringatan SLA sengketa',
      body: 'Sengketa pesanan "{orderTitle}" mendekati batas waktu penanganan ({deadline}).',
    },
    en: {
      title: 'Dispute SLA warning',
      body: 'The dispute for order "{orderTitle}" is approaching its handling deadline ({deadline}).',
    },
  },
  [NotificationType.DISPUTE_ESCALATION_SLA_BREACHED]: {
    id: {
      title: 'SLA sengketa terlewati',
      body: 'Penanganan sengketa pesanan "{orderTitle}" melewati batas waktu. Kasus ini telah dieskalasi.',
    },
    en: {
      title: 'Dispute SLA breached',
      body: 'Handling of the dispute for order "{orderTitle}" exceeded the time limit. This case has been escalated.',
    },
  },
  [NotificationType.DISPUTE_DECISION]: {
    id: {
      title: 'Keputusan sengketa',
      body: 'Sengketa pesanan "{orderTitle}" telah diputuskan: {outcome}.',
    },
    en: {
      title: 'Dispute decision',
      body: 'The dispute for order "{orderTitle}" has been decided: {outcome}.',
    },
  },
  [NotificationType.DISPUTE_EVIDENCE_SUBMITTED]: {
    id: {
      title: 'Bukti baru dalam sengketa',
      body: '{submitterName} mengirim bukti baru untuk sengketa pesanan "{orderTitle}".',
    },
    en: {
      title: 'New dispute evidence',
      body: '{submitterName} submitted new evidence for the dispute on order "{orderTitle}".',
    },
  },
  [NotificationType.DISPUTE_CLAIM_SUBMITTED]: {
    id: {
      title: 'Klaim sengketa diajukan',
      body: 'Klaim telah diajukan untuk sengketa pesanan "{orderTitle}".',
    },
    en: {
      title: 'Dispute claim submitted',
      body: 'A claim has been submitted for the dispute on order "{orderTitle}".',
    },
  },
  [NotificationType.DISPUTE_ESCALATED]: {
    id: {
      title: 'Sengketa dieskalasi',
      body: 'Sengketa pesanan "{orderTitle}" telah dieskalasi ke tim senior Kahade.',
    },
    en: {
      title: 'Dispute escalated',
      body: 'The dispute for order "{orderTitle}" has been escalated to the senior Kahade team.',
    },
  },
  // ------------------------------------------------------------------- CHAT
  [NotificationType.CHAT_NEW_MESSAGE]: {
    id: {
      title: 'Pesan dari {senderName}',
      body: '{preview}',
    },
    en: {
      title: 'Message from {senderName}',
      body: '{preview}',
    },
  },
  // ------------------------------------------------------- SUPPORT LIVECHAT
  // POIN 5 (2026-10-04): balasan agen livechat ke user. Berbeda dengan chat
  // biasa (yang tidak masuk notifikasi in-app), balasan agen jarang & penting.
  [NotificationType.SUPPORT_AGENT_REPLY]: {
    id: {
      title: 'Balasan dari {agentName}',
      body: '{preview}',
    },
    en: {
      title: 'Reply from {agentName}',
      body: '{preview}',
    },
  },
  // ----------------------------------------------------------------- WALLET
  [NotificationType.WALLET_TOPUP_SUCCESS]: {
    id: {
      title: 'Top-up berhasil',
      body: 'Top-up {amount} telah dikreditkan ke wallet Anda.',
    },
    en: {
      title: 'Top-up successful',
      body: 'Top-up of {amount} has been credited to your wallet.',
    },
  },
  [NotificationType.WALLET_TOPUP_FAILED]: {
    id: {
      title: 'Top-up gagal',
      body: 'Top-up {amount} gagal diproses. Silakan coba lagi.',
    },
    en: {
      title: 'Top-up failed',
      body: 'Top-up of {amount} failed to process. Please try again.',
    },
  },
  [NotificationType.WALLET_WITHDRAW_SUCCESS]: {
    id: {
      title: 'Penarikan berhasil',
      body: 'Penarikan {amount} berhasil diproses.',
    },
    en: {
      title: 'Withdrawal successful',
      body: 'Withdrawal of {amount} has been processed successfully.',
    },
  },
  [NotificationType.WALLET_WITHDRAW_FAILED]: {
    id: {
      title: 'Penarikan gagal',
      body: 'Penarikan {amount} gagal diproses. Dana dikembalikan ke wallet Anda.',
    },
    en: {
      title: 'Withdrawal failed',
      body: 'Withdrawal of {amount} failed to process. The funds were returned to your wallet.',
    },
  },
  [NotificationType.WALLET_FUNDS_RELEASED]: {
    id: {
      title: 'Dana cair',
      body: 'Pesanan "{orderTitle}" selesai. {amount} telah dikreditkan ke wallet Anda.',
    },
    en: {
      title: 'Funds released',
      body: 'Order "{orderTitle}" completed. {amount} has been credited to your wallet.',
    },
  },
  [NotificationType.WALLET_REFUND_RECEIVED]: {
    id: {
      title: 'Refund diterima',
      body: 'Refund {amount} untuk pesanan "{orderTitle}" telah dikreditkan ke wallet Anda.',
    },
    en: {
      title: 'Refund received',
      body: 'Refund of {amount} for order "{orderTitle}" has been credited to your wallet.',
    },
  },
  [NotificationType.WALLET_TRANSFER_SENT]: {
    id: {
      title: 'Transfer terkirim',
      body: 'Anda mengirim {amount} ke {recipientName}.',
    },
    en: {
      title: 'Transfer sent',
      body: 'You sent {amount} to {recipientName}.',
    },
  },
  [NotificationType.WALLET_TRANSFER_RECEIVED]: {
    id: {
      title: 'Transfer diterima',
      body: 'Anda menerima {amount} dari {senderName}.',
    },
    en: {
      title: 'Transfer received',
      body: 'You received {amount} from {senderName}.',
    },
  },
  [NotificationType.ESCROW_HELD_NO_BANK]: {
    id: {
      title: 'Dana escrow menunggu rekening bank',
      body: 'Dana {amount} dari pesanan "{orderTitle}" ditahan di escrow karena Anda belum menghubungkan rekening bank. Hubungkan rekening untuk mencairkan dana.',
    },
    en: {
      title: 'Escrow funds awaiting bank account',
      body: '{amount} from order "{orderTitle}" is held in escrow because you have not linked a bank account yet. Link a bank account to release the funds.',
    },
  },
  // -------------------------------------------------------------------- KYC
  [NotificationType.KYC_APPROVED]: {
    id: {
      title: 'Verifikasi identitas disetujui',
      body: 'Selamat! Verifikasi identitas (KYC) Anda telah disetujui.',
    },
    en: {
      title: 'Identity verification approved',
      body: 'Congratulations! Your identity verification (KYC) has been approved.',
    },
  },
  [NotificationType.KYC_REJECTED]: {
    id: {
      title: 'Verifikasi identitas ditolak',
      body: 'Verifikasi identitas (KYC) Anda ditolak.{reason} Silakan ajukan ulang dengan dokumen yang valid.',
    },
    en: {
      title: 'Identity verification rejected',
      body: 'Your identity verification (KYC) was rejected.{reason} Please resubmit with valid documents.',
    },
  },
  [NotificationType.KYC_REVOKED]: {
    id: {
      title: 'Verifikasi identitas dicabut',
      body: 'Status verifikasi identitas (KYC) Anda telah dicabut. Hubungi dukungan untuk informasi lebih lanjut.',
    },
    en: {
      title: 'Identity verification revoked',
      body: 'Your identity verification (KYC) status has been revoked. Please contact support for more information.',
    },
  },
  [NotificationType.KYC_RESUBMIT_REMINDER]: {
    id: {
      title: 'Pengingat verifikasi identitas',
      body: 'Pengajuan verifikasi identitas (KYC) Anda belum lengkap. Segera lengkapi untuk membuka seluruh fitur Kahade.',
    },
    en: {
      title: 'Identity verification reminder',
      body: 'Your identity verification (KYC) submission is incomplete. Complete it soon to unlock all Kahade features.',
    },
  },
  [NotificationType.BUSINESS_VERIFICATION_APPROVED]: {
    id: {
      title: 'Verifikasi badan usaha disetujui',
      body: 'Verifikasi badan usaha Anda telah disetujui.',
    },
    en: {
      title: 'Business verification approved',
      body: 'Your business verification has been approved.',
    },
  },
  [NotificationType.BUSINESS_VERIFICATION_REJECTED]: {
    id: {
      title: 'Verifikasi badan usaha ditolak',
      body: 'Verifikasi badan usaha Anda ditolak.{reason}',
    },
    en: {
      title: 'Business verification rejected',
      body: 'Your business verification was rejected.{reason}',
    },
  },
  [NotificationType.BUSINESS_VERIFICATION_REVOKED]: {
    id: {
      title: 'Verifikasi badan usaha dicabut',
      body: 'Status verifikasi badan usaha Anda telah dicabut. Hubungi dukungan untuk informasi lebih lanjut.',
    },
    en: {
      title: 'Business verification revoked',
      body: 'Your business verification status has been revoked. Please contact support for more information.',
    },
  },
  // --------------------------------------------------------------- SECURITY
  [NotificationType.SECURITY_NEW_LOGIN]: {
    id: {
      title: 'Login perangkat baru',
      body: 'Akun Anda masuk dari perangkat baru ({device}) pada {time}. Jika ini bukan Anda, segera amankan akun Anda.',
    },
    en: {
      title: 'New device login',
      body: 'Your account was signed in from a new device ({device}) at {time}. If this was not you, secure your account immediately.',
    },
  },
  [NotificationType.SECURITY_PASSWORD_CHANGED]: {
    id: {
      title: 'Kata sandi diubah',
      body: 'Kata sandi akun Anda telah diubah pada {time}. Jika ini bukan Anda, segera hubungi dukungan.',
    },
    en: {
      title: 'Password changed',
      body: 'Your account password was changed at {time}. If this was not you, contact support immediately.',
    },
  },
  [NotificationType.SECURITY_ACCOUNT_LOCKED]: {
    id: {
      title: 'Akun dikunci',
      body: 'Akun Anda telah dikunci sementara demi keamanan.{reason} Hubungi dukungan pelanggan untuk bantuan.',
    },
    en: {
      title: 'Account locked',
      body: 'Your account has been temporarily locked for security.{reason} Please contact customer support for assistance.',
    },
  },
  [NotificationType.SECURITY_2FA_ENABLED]: {
    id: {
      title: 'Verifikasi 2 langkah aktif',
      body: 'Verifikasi dua langkah (2FA) telah diaktifkan untuk akun Anda.',
    },
    en: {
      title: '2-step verification enabled',
      body: 'Two-step verification (2FA) has been enabled for your account.',
    },
  },
  [NotificationType.SECURITY_2FA_DISABLED]: {
    id: {
      title: 'Verifikasi 2 langkah nonaktif',
      body: 'Verifikasi dua langkah (2FA) telah dinonaktifkan untuk akun Anda. Jika ini bukan Anda, segera hubungi dukungan.',
    },
    en: {
      title: '2-step verification disabled',
      body: 'Two-step verification (2FA) has been disabled for your account. If this was not you, contact support immediately.',
    },
  },
  [NotificationType.SECURITY_BACKUP_CODE_USED]: {
    id: {
      title: 'Kode cadangan digunakan',
      body: 'Salah satu kode cadangan 2FA Anda telah digunakan pada {time}. Segera buat kode cadangan baru.',
    },
    en: {
      title: 'Backup code used',
      body: 'One of your 2FA backup codes was used at {time}. Please generate new backup codes soon.',
    },
  },
  [NotificationType.SECURITY_SOCIAL_LINKED]: {
    id: {
      title: 'Akun sosial terhubung',
      body: 'Akun {provider} telah terhubung ke akun Kahade Anda.',
    },
    en: {
      title: 'Social account linked',
      body: 'Your {provider} account has been linked to your Kahade account.',
    },
  },
  [NotificationType.SECURITY_SOCIAL_UNLINKED]: {
    id: {
      title: 'Akun sosial dilepas',
      body: 'Akun {provider} telah dilepas dari akun Kahade Anda.',
    },
    en: {
      title: 'Social account unlinked',
      body: 'Your {provider} account has been unlinked from your Kahade account.',
    },
  },
  // ----------------------------------------------------------- SUBSCRIPTION
  [NotificationType.SUBSCRIPTION_ACTIVATED]: {
    id: {
      title: 'Kahade Plus aktif',
      body: 'Langganan {plan} Anda telah aktif. Nikmati biaya layanan yang lebih rendah!',
    },
    en: {
      title: 'Kahade Plus activated',
      body: 'Your {plan} subscription is now active. Enjoy lower service fees!',
    },
  },
  [NotificationType.SUBSCRIPTION_EXPIRY_REMINDER]: {
    id: {
      title: 'Langganan Plus segera berakhir',
      body: 'Langganan Kahade Plus Anda akan berakhir dalam {window}. Perpanjang sekarang agar manfaat Plus tetap aktif.',
    },
    en: {
      title: 'Plus subscription expiring soon',
      body: 'Your Kahade Plus subscription will expire in {window}. Renew now to keep your Plus benefits active.',
    },
  },
  [NotificationType.SUBSCRIPTION_EXPIRED]: {
    id: {
      title: 'Langganan Kahade Plus berakhir',
      body: 'Masa tenggang langganan Kahade Plus Anda telah berakhir. Biaya layanan kembali ke tarif standar. Berlangganan lagi untuk menikmati biaya lebih rendah.',
    },
    en: {
      title: 'Kahade Plus subscription expired',
      body: 'Your Kahade Plus grace period has ended and your subscription is now expired. Service fees will revert to the standard rate. Subscribe again to enjoy lower fees.',
    },
  },
  [NotificationType.SUBSCRIPTION_RENEWED]: {
    id: {
      title: 'Kahade Plus diperpanjang otomatis',
      body: 'Langganan {plan} Anda telah diperpanjang otomatis. Nikmati terus manfaat Plus Anda!',
    },
    en: {
      title: 'Kahade Plus auto-renewed',
      body: 'Your {plan} subscription has been auto-renewed successfully. Enjoy your continued Plus benefits!',
    },
  },
  // -------------------------------------------------------------- PROMO dkk
  [NotificationType.REFERRAL_REWARD_RECEIVED]: {
    id: {
      title: 'Hadiah referral diterima',
      body: 'Anda menerima hadiah referral {amount}. Terima kasih telah mengajak teman ke Kahade!',
    },
    en: {
      title: 'Referral reward received',
      body: 'You received a referral reward of {amount}. Thank you for inviting friends to Kahade!',
    },
  },
  [NotificationType.RATING_NEW]: {
    id: {
      title: 'Ulasan baru',
      body: '{giverName} memberi Anda ulasan bintang {stars}.{comment}',
    },
    en: {
      title: 'New rating',
      body: '{giverName} gave you a {stars}-star rating.{comment}',
    },
  },
  [NotificationType.BADGE_AWARDED]: {
    id: {
      title: 'Lencana baru!',
      body: 'Selamat! Anda mendapatkan lencana "{badgeName}".',
    },
    en: {
      title: 'New badge!',
      body: 'Congratulations! You earned the "{badgeName}" badge.',
    },
  },
  [NotificationType.RANK_UPGRADED]: {
    id: {
      title: 'Naik rank ke {rank}',
      body: 'Selamat! Rank membership Anda naik ke {rank}. Voucher {voucherCode} sudah ditambahkan ke akun Anda.',
    },
    en: {
      title: 'Ranked up to {rank}',
      body: 'Congratulations! Your membership rank is now {rank}. Voucher {voucherCode} has been added to your account.',
    },
  },
  [NotificationType.VOUCHER_ISSUED]: {
    id: {
      title: 'Voucher baru',
      body: 'Voucher {code} telah ditambahkan ke akun Anda.{detail}',
    },
    en: {
      title: 'New voucher',
      body: 'Voucher {code} has been added to your account.{detail}',
    },
  },
  [NotificationType.CAMPAIGN_CASHBACK_CREDITED]: {
    id: {
      title: 'Cashback terkirim',
      body: 'Cashback {amount} dari pesanan "{orderTitle}" telah dikirim ke rekening bank Anda.',
    },
    en: {
      title: 'Cashback credited',
      body: 'Cashback {amount} from order "{orderTitle}" has been credited to your wallet.',
    },
  },
  [NotificationType.TOPUP_BONUS_CREDITED]: {
    id: {
      title: 'Bonus top-up diterima',
      body: 'Bonus top-up {amount} telah dikreditkan ke wallet Anda.',
    },
    en: {
      title: 'Top-up bonus credited',
      body: 'Top-up bonus {amount} has been credited to your wallet.',
    },
  },
  // ----------------------------------------------------------------- SYSTEM
  [NotificationType.QUESTION_UNANSWERED_REMINDER]: {
    id: {
      title: 'Pengingat pertanyaan profil',
      body: 'Anda memiliki pertanyaan profil yang belum dijawab. Lengkapi untuk meningkatkan kepercayaan pembeli.',
    },
    en: {
      title: 'Profile question reminder',
      body: 'You have unanswered profile questions. Complete them to increase buyer trust.',
    },
  },
  [NotificationType.DATA_EXPORT_READY]: {
    id: {
      title: 'Ekspor data siap',
      body: 'File ekspor data Anda sudah siap diunduh.',
    },
    en: {
      title: 'Data export ready',
      body: 'Your data export file is ready to download.',
    },
  },
  [NotificationType.SYSTEM_MAINTENANCE]: {
    id: {
      title: 'Pemeliharaan sistem',
      body: '{detail}',
    },
    en: {
      title: 'System maintenance',
      body: '{detail}',
    },
  },
  [NotificationType.SYSTEM_ANNOUNCEMENT]: {
    id: {
      title: '{title}',
      body: '{body}',
    },
    en: {
      title: '{title}',
      body: '{body}',
    },
  },
  // --------------------------------------------------------------- MILESTONE
  [NotificationType.MILESTONE_SUBMITTED]: {
    id: {
      title: 'Tahap diajukan',
      body: 'Tahap {seq} "{title}" untuk pesanan "{orderTitle}" telah diajukan penjual. Mohon tinjau.',
    },
    en: {
      title: 'Milestone submitted',
      body: 'Milestone {seq} "{title}" for order "{orderTitle}" has been submitted by the seller. Please review.',
    },
  },
  [NotificationType.MILESTONE_REVISION_REQUESTED]: {
    id: {
      title: 'Revisi tahap diminta',
      body: 'Pembeli meminta revisi untuk tahap {seq} "{title}" pesanan "{orderTitle}".{note}',
    },
    en: {
      title: 'Milestone revision requested',
      body: 'The buyer requested a revision for milestone {seq} "{title}" of order "{orderTitle}".{note}',
    },
  },
  [NotificationType.MILESTONE_ACCEPTED]: {
    id: {
      title: 'Tahap diterima',
      body: 'Tahap {seq} "{title}" pesanan "{orderTitle}" telah diterima.',
    },
    en: {
      title: 'Milestone accepted',
      body: 'Milestone {seq} "{title}" of order "{orderTitle}" has been accepted.',
    },
  },
  [NotificationType.MILESTONE_RELEASED]: {
    id: {
      title: 'Dana tahap dicairkan',
      body: 'Dana {amount} untuk tahap {seq} "{title}" pesanan "{orderTitle}" telah dicairkan.',
    },
    en: {
      title: 'Milestone funds released',
      body: '{amount} for milestone {seq} "{title}" of order "{orderTitle}" has been released.',
    },
  },
  [NotificationType.MILESTONE_DEADLINE_REMINDER]: {
    id: {
      title: 'Pengingat batas tahap',
      body: 'Tahap {seq} "{title}" pesanan "{orderTitle}" mendekati batas waktu ({deadline}).',
    },
    en: {
      title: 'Milestone deadline reminder',
      body: 'Milestone {seq} "{title}" of order "{orderTitle}" is approaching its deadline ({deadline}).',
    },
  },
  [NotificationType.MILESTONE_CANCELLED]: {
    id: {
      title: 'Tahap dibatalkan',
      body: 'Tahap {seq} "{title}" pesanan "{orderTitle}" telah dibatalkan.',
    },
    en: {
      title: 'Milestone cancelled',
      body: 'Milestone {seq} "{title}" of order "{orderTitle}" has been cancelled.',
    },
  },
  // --------------------------------------------------------------- MODERASI
  [NotificationType.MODERATION_REPORT_UPDATE]: {
    id: {
      title: 'Update laporan etalase Anda',
      body: 'Laporan Anda terhadap item "{itemTitle}" telah ditinjau: {outcome}. Terima kasih atas partisipasinya menjaga keamanan Kahade.',
    },
    en: {
      title: 'Update on your showcase report',
      body: 'Your report on the item "{itemTitle}" has been reviewed: {outcome}. Thank you for helping keep Kahade safe.',
    },
  },
  [NotificationType.MODERATION_ITEM_TAKEDOWN]: {
    id: {
      title: '{title}',
      body: '{body}',
    },
    en: {
      title: '{title}',
      body: '{body}',
    },
  },
  [NotificationType.MODERATION_APPEAL_DECIDED]: {
    id: {
      title: 'Banding {decision}',
      body: '{body}',
    },
    en: {
      title: 'Appeal {decision}',
      body: '{body}',
    },
  },
  [NotificationType.DIGEST_SUMMARY]: {
    id: {
      title: 'Ringkasan aktivitas',
      body: '{summary}',
    },
    en: {
      title: 'Activity digest',
      body: '{summary}',
    },
  },
};

function interpolate(template: string, params: NotificationCopyParams): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Render copy notifikasi untuk tipe + bahasa + params tertentu.
 * Placeholder yang tidak ada di params dibiarkan apa adanya (`{nama}`)
 * agar tidak menghasilkan string rusak diam-diam.
 */
export function renderNotificationCopy(
  type: NotificationType,
  lang: NotificationLang,
  params: NotificationCopyParams = {},
): NotificationCopyTemplate {
  const entry = NOTIFICATION_COPY[type];
  if (!entry) {
    throw new RangeError(`renderNotificationCopy: no template for NotificationType ${String(type)}`);
  }
  const tpl = entry[lang] ?? entry.id;
  return { title: interpolate(tpl.title, params), body: interpolate(tpl.body, params) };
}

/**
 * Bahasa notifikasi preferensi user — SATU implementasi kanonis.
 * `NotificationsService.getUserLanguage()` mendelegasikan ke sini
 * (sebelumnya logika ini hanya hidup di sana tanpa pemanggil).
 */
export async function resolveNotificationLanguage(
  prisma: {
    notificationPreference: {
      findUnique(args: { where: { userId: string } }): Promise<{ language?: string | null } | null>;
    };
  },
  userId: string,
): Promise<NotificationLang> {
  try {
    const prefs = await prisma.notificationPreference.findUnique({ where: { userId } });
    return prefs?.language === 'en' ? 'en' : 'id';
  } catch {
    return 'id';
  }
}

@Injectable()
export class NotificationCopyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Bahasa preferensi user (delegasi ke implementasi kanonis). */
  getLanguage(userId: string): Promise<NotificationLang> {
    return resolveNotificationLanguage(this.prisma, userId);
  }

  /**
   * Ambil copy (title/body) yang sudah dilokalkan untuk user + tipe ini.
   * Dipakai di call-site `prisma.notification.create`:
   *   const copy = await this.notificationCopy.getCopy(userId, NotificationType.X, { amount });
   */
  async getCopy(
    userId: string,
    type: NotificationType,
    params: NotificationCopyParams = {},
  ): Promise<NotificationCopyTemplate & { lang: NotificationLang }> {
    const lang = await this.getLanguage(userId);
    const copy = renderNotificationCopy(type, lang, params);
    return { ...copy, lang };
  }
}
