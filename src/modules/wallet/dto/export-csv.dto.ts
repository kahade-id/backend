import {
  IsOptional,
  IsDateString,
  IsIn,
  ArrayMaxSize,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { WalletTransactionType } from '@prisma/client';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';

// R2-K (audit): an unknown type string used to flow straight into the Prisma
// `type: { in: [...] }` filter and blew up with a P2023 500; validate against the
// enum here instead.
const WALLET_TX_TYPES = Object.keys(WalletTransactionType) as string[];

// Absolute ceiling for any single export request. The operator-configured
// EXPORT_MAX_DATE_RANGE_DAYS (default 90, max 365) is additionally enforced in
// WalletExportService, so this is only the hard backstop.
const ABSOLUTE_MAX_EXPORT_DAYS = 365;

@ValidatorConstraint({ name: 'dateRangeLimit', async: false })
class DateRangeLimitConstraint implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments): boolean {
    const obj = args.object as ExportCsvDto;
    // AUDIT: the check used to bail out when only ONE bound was provided, so
    // `?from=2019-01-01` (no `to`) skipped the range limit entirely. Treat a
    // missing bound as "now" so single-sided ranges are bounded too.
    const fromDate = obj.from ? parseDateBoundaryWIB(obj.from, 'start') : undefined;
    const toDate = obj.to ? parseDateBoundaryWIB(obj.to, 'end') : undefined;
    if (!fromDate && !toDate) return true;
    const effectiveFrom =
      fromDate ?? new Date(Date.now() - ABSOLUTE_MAX_EXPORT_DAYS * 24 * 60 * 60 * 1000);
    const effectiveTo = toDate ?? new Date();
    const diffMs = effectiveTo.getTime() - effectiveFrom.getTime();
    return diffMs >= 0 && diffMs <= ABSOLUTE_MAX_EXPORT_DAYS * 24 * 60 * 60 * 1000;
  }

  defaultMessage(): string {
    return `Date range must not exceed ${ABSOLUTE_MAX_EXPORT_DAYS} days, and "to" must be after "from"`;
  }
}

export class ExportCsvDto {
  @IsOptional()
  @IsDateString()
  @Validate(DateRangeLimitConstraint)
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
