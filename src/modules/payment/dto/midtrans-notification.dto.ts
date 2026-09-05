import { IsString, IsNotEmpty, IsOptional, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MidtransNotificationDto {
  @ApiProperty({ description: 'Order ID from Midtrans' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  order_id!: string;

  @ApiProperty({ description: 'Status code' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  @Matches(/^\d{3}$/)
  status_code!: string;

  @ApiProperty({ description: 'Gross amount' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^\d+(?:\.\d{1,2})?$/)
  gross_amount!: string;

  @ApiProperty({ description: 'Signature key for verification' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  signature_key!: string;

  @ApiProperty({ description: 'Transaction status' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  transaction_status!: string;

  @ApiProperty({ description: 'Transaction ID' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(/\S/)
  transaction_id!: string;

  @ApiPropertyOptional({ description: 'Payment type' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  payment_type?: string;

  @ApiPropertyOptional({ description: 'Fraud status' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  fraud_status?: string;

  @ApiPropertyOptional({ description: 'Cumulative amount refunded by Midtrans, for refund and partial_refund notifications' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^\d+(?:\.\d{1,2})?$/)
  refund_amount?: string;

  @ApiPropertyOptional({ description: 'Merchant refund reference used to make refund webhook delivery idempotent' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/\S/)
  refund_key?: string;
}
