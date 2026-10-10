import { IsEnum, IsString, IsNotEmpty, IsInt, Min, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum UploadPurpose {
  KYC_KTP = 'KYC_KTP',
  KYC_SELFIE = 'KYC_SELFIE',
  KYC_PASSPORT = 'KYC_PASSPORT',
  KYC_LIVENESS = 'KYC_LIVENESS',
  // Section 1 (Verified Badge System): dokumen legalitas badan usaha
  // (NPWP / akta pendirian / SIUP). Private bucket, sama seperti dokumen KYC.
  BUSINESS_DOCUMENT = 'BUSINESS_DOCUMENT',
  // Section 3 (Showcase social content): gambar item showcase. PUBLIC bucket
  // karena gambar ini memang ditayangkan di feed discover & profil publik.
  SHOWCASE_IMAGE = 'SHOWCASE_IMAGE',
  // Batch 19 TIM A (item 1): video item showcase (video/*). PUBLIC bucket,
  // diserve nginx dengan HTTP Range; thumbnail JPEG dibuat server-side
  // (ffmpeg) dan disimpan di folder SHOWCASE_IMAGE.
  SHOWCASE_VIDEO = 'SHOWCASE_VIDEO',
  // Story photos use the existing /upload/direct disk pipeline, but remain
  // private and are resized/re-encoded by the server before being stored.
  STORY_MEDIA = 'STORY_MEDIA',
  // Internal-only archive copies created by StoryService; never accepted by
  // the public upload controller.
  STORY_HIGHLIGHT = 'STORY_HIGHLIGHT',
  AVATAR = 'AVATAR',
  // BE-5 (audit etalase 2026-10-10): berkas aset digital produk DIGITAL —
  // PRIVAT; pembeli berbayar mengunduh lewat signed URL
  // GET /v1/commerce/digital-assets/:id/download (bukan /upload/my-file
  // yang owner-only).
  DIGITAL_ASSET = 'DIGITAL_ASSET',
  CHAT_ATTACHMENT = 'CHAT_ATTACHMENT',
  DISPUTE_EVIDENCE = 'DISPUTE_EVIDENCE',
  REPORT_EVIDENCE = 'REPORT_EVIDENCE',
  DELIVERY_PROOF = 'DELIVERY_PROOF',
  // BFI-097 (audit integrasi 2026-09-30): bukti penyelesaian milestone
  // (FE: app/milestones/[id].tsx → uploadDirectImage). Private, sama seperti
  // bukti sengketa/laporan — hanya pemilik + pihak terkait yang boleh baca
  // via signed URL.
  MILESTONE_EVIDENCE = 'MILESTONE_EVIDENCE',
  // Karir karir.kahade.id (Fase F2, 2026-10-03): CV pelamar. PDF-only,
  // maks 5 MB, storage privat folder `career-cvs` — tanpa akun.
  CAREER_CV = 'CAREER_CV',
}

export class PresignedUrlDto {
  @ApiProperty({
    enum: UploadPurpose,
    description: 'Upload purpose determines allowed content types, max file size, and URL expiry duration',
  })
  @IsEnum(UploadPurpose)
  purpose!: UploadPurpose;

  @ApiProperty({ example: 'photo.jpg' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  contentType!: string;

  @ApiProperty({ example: 102400, description: 'Exact file size in bytes. Must be within the allowed range for the upload purpose.' })
  @IsInt()
  @Min(1024)
  fileSize!: number;
}
