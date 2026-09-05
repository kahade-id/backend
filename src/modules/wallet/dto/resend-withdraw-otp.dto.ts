import { ApiProperty } from '@nestjs/swagger';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';

export class ResendWithdrawOtpDto {
  @ApiProperty({ description: 'Transaction ID of the pending withdrawal' })
  @IsValidId()
  txId!: string;
}
