import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RefreshTokenDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;

  /**
   * AUT-006: identitas perangkat peminta (dikirim FE di body refresh —
   * mobile maupun web). Server menolak bila tidak cocok dengan `deviceId`
   * baris sesi. Opsional agar klien lama / alur cookie-only tetap jalan
   * (jalur transisi).
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;
}
