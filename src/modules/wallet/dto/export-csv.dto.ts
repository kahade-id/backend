import { IsOptional, IsDateString, IsIn, IsString, ArrayMaxSize, Validate, ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';
import { parseDateBoundaryWIB } from '../../../common/utils/date.util';

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
  @IsString({ each: true })
  @ArrayMaxSize(10)
  types?: string[];
}
