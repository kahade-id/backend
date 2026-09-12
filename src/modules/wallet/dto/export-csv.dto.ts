import { IsOptional, IsDateString, IsIn, ArrayMaxSize, Validate, ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';
import { WalletTransactionType } from '@prisma/client';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';

// R2-K (audit): an unknown type string used to flow straight into the Prisma
// `type: { in: [...] }` filter and blew up with a P2023 500; validate against the
// enum here instead.
const WALLET_TX_TYPES = Object.keys(WalletTransactionType) as string[];

@ValidatorConstraint({ name: 'dateRangeLimit', async: false })
class DateRangeLimitConstraint implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments): boolean {
    const obj = args.object as ExportCsvDto;
    if (!obj.from || !obj.to) return true;
    const fromDate = parseDateBoundaryWIB(obj.from, 'start');
    const toDate = parseDateBoundaryWIB(obj.to, 'end');
    if (!fromDate || !toDate) return false;
    const diffMs = toDate.getTime() - fromDate.getTime();
    const MAX_DAYS = 365;
    return diffMs >= 0 && diffMs <= MAX_DAYS * 24 * 60 * 60 * 1000;
  }

  defaultMessage(): string {
    return 'Date range must not exceed 365 days, and "to" must be after "from"';
  }
}

export class ExportCsvDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  @Validate(DateRangeLimitConstraint)
  to?: string;

  @IsOptional()
  @IsIn(['csv', 'xlsx'])
  format?: string;

  @IsOptional()
  @IsIn(WALLET_TX_TYPES, { each: true })
  @ArrayMaxSize(10)
  types?: string[];
}
