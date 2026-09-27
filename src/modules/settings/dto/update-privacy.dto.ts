import { IsOptional, IsBoolean, IsEnum, IsArray, IsString, ArrayMaxSize } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PrivacyListVisibility, QaCommentPolicy, ShowcaseVisibility } from '@prisma/client';

/**
 * G076–G083: kontrol privasi granular. Semua field opsional (PATCH semantics) —
 * hanya field yang dikirim yang diubah. Field lama (profileVisible,
 * showOnlineStatus) tetap didukung agar kontrak existing tidak putus.
 */
export class UpdatePrivacyDto {
  @ApiPropertyOptional({ description: 'Profile visibility' })
  @IsOptional()
  @IsBoolean()
  profileVisible?: boolean;

  @ApiPropertyOptional({ description: 'Show online status' })
  @IsOptional()
  @IsBoolean()
  showOnlineStatus?: boolean;

  // G076: visibilitas field identitas (berlaku untuk viewer != owner).
  @ApiPropertyOptional({ description: 'Tampilkan email akun ke pengunjung profil' })
  @IsOptional()
  @IsBoolean()
  showEmail?: boolean;

  @ApiPropertyOptional({ description: 'Tampilkan nomor HP akun ke pengunjung profil' })
  @IsOptional()
  @IsBoolean()
  showPhone?: boolean;

  @ApiPropertyOptional({ description: 'Tampilkan tanggal lahir ke pengunjung profil' })
  @IsOptional()
  @IsBoolean()
  showDob?: boolean;

  @ApiPropertyOptional({ description: 'Tampilkan gender ke pengunjung profil' })
  @IsOptional()
  @IsBoolean()
  showGender?: boolean;

  // G077
  @ApiPropertyOptional({ enum: PrivacyListVisibility, description: 'Siapa yang dapat melihat daftar follower' })
  @IsOptional()
  @IsEnum(PrivacyListVisibility)
  showFollowerList?: PrivacyListVisibility;

  @ApiPropertyOptional({ enum: PrivacyListVisibility, description: 'Siapa yang dapat melihat daftar following' })
  @IsOptional()
  @IsEnum(PrivacyListVisibility)
  showFollowingList?: PrivacyListVisibility;

  // G078
  @ApiPropertyOptional({ enum: ShowcaseVisibility, description: 'Visibilitas default karya etalase baru' })
  @IsOptional()
  @IsEnum(ShowcaseVisibility)
  showcaseDefaultVisibility?: ShowcaseVisibility;

  // G079–G080
  @ApiPropertyOptional({ enum: QaCommentPolicy, description: 'Siapa yang dapat bertanya/berkomentar di Q&A profil' })
  @IsOptional()
  @IsEnum(QaCommentPolicy)
  qaCommentPolicy?: QaCommentPolicy;

  @ApiPropertyOptional({ description: 'Jawaban Q&A baru tidak publik sampai diterbitkan pemilik' })
  @IsOptional()
  @IsBoolean()
  qaAnswerModeration?: boolean;

  // G081–G082
  @ApiPropertyOptional({ description: 'Tampilkan ulasan/rating di profil publik' })
  @IsOptional()
  @IsBoolean()
  showReviews?: boolean;

  @ApiPropertyOptional({ description: 'Kunci statistik yang disembunyikan dari pengunjung publik', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  hiddenStats?: string[];

  // G083
  @ApiPropertyOptional({ description: 'Izinkan profil diindeks mesin pencari' })
  @IsOptional()
  @IsBoolean()
  searchEngineIndex?: boolean;
}
