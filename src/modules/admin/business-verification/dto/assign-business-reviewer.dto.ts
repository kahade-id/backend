import { IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignBusinessReviewerDto {
  @ApiProperty({ description: 'ID admin yang ditugaskan sebagai reviewer (harus admin aktif)' })
  @IsString()
  @Matches(/\S/, { message: 'adminId must contain non-whitespace text' })
  adminId!: string;
}
