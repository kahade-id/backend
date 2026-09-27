import { IsString, IsIn, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** GAP-E — ubah role admin (alasan wajib, audit ADMIN_ROLE_CHANGED before/after). */
export class ChangeAdminRoleDto {
  @ApiProperty({
    description: 'Role baru.',
    enum: ['SUPER_ADMIN', 'DISPUTE_ADMIN', 'KYC_ADMIN', 'FINANCE_ADMIN', 'CUSTOMER_SUPPORT'],
  })
  @IsString()
  @IsIn(['SUPER_ADMIN', 'DISPUTE_ADMIN', 'KYC_ADMIN', 'FINANCE_ADMIN', 'CUSTOMER_SUPPORT'])
  role!: 'SUPER_ADMIN' | 'DISPUTE_ADMIN' | 'KYC_ADMIN' | 'FINANCE_ADMIN' | 'CUSTOMER_SUPPORT';

  @ApiProperty({ description: 'Alasan perubahan role (wajib) — tercatat di audit.' })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
