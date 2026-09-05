import { IsString, IsOptional, IsIn, MaxLength, Matches, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDeviceDto {
  @ApiProperty({ description: 'Push notification token', maxLength: 512 })
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  @Matches(/^[a-zA-Z0-9:._/\-[\]]+$/, { message: 'Invalid push notification token format' })
  token!: string;

  @ApiPropertyOptional({ enum: ['android', 'ios', 'web'], description: 'Device platform' })
  @IsOptional()
  @IsString()
  @IsIn(['android', 'ios', 'web'])
  platform?: string;

  // D-03: the mobile client has always sent this (`lib/pushNotifications.ts`, alongside
  // `token`/`platform`), but it was never declared here. `main.ts:224` sets
  // `forbidNonWhitelisted: true`, so an undeclared property is not stripped — it is a hard 400
  // ("property deviceId should not exist"). Every push registration therefore failed, and the
  // client's `catch` only `console.warn`s, so the feature was silently dead rather than loud.
  //
  // It is also the device's real identity: `UserDevice` is keyed `@@unique([userId, deviceId])`
  // (`schema.prisma`) and `auth.service.ts:2183` already tracks logins under this same
  // fingerprint. Declaring it lets registration key on the install instead of guessing from
  // `deviceType` (D-04).
  @ApiPropertyOptional({ description: 'Stable per-install device fingerprint', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9:._-]+$/, { message: 'Invalid device ID format' })
  deviceId?: string;
}
