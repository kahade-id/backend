import { IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignReviewerDto {
  @ApiProperty({ description: 'ID admin (format ADMIN-XXXXX) yang ditugaskan sebagai reviewer' })
  @IsString()
  @Matches(/^ADMIN-[A-Za-z0-9_-]{3,40}$/, { message: 'adminId must be a valid admin ID' })
  adminId!: string;
}
