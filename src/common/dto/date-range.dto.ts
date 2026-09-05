import { IsOptional, IsISO8601, IsEnum, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { endOfDayWIB, startOfDayWIB, toWIB } from '../utils/date.util';

export enum DateRangePreset {
  TODAY = 'today',
  YESTERDAY = 'yesterday',
  LAST_7_DAYS = 'last_7_days',
  LAST_30_DAYS = 'last_30_days',
  THIS_MONTH = 'this_month',
  LAST_MONTH = 'last_month',
  CUSTOM = 'custom',
}

export class DateRangeDto {
  @ApiPropertyOptional({ enum: DateRangePreset })
  @IsOptional()
  @IsEnum(DateRangePreset)
  preset?: DateRangePreset;

  @ApiPropertyOptional({ description: 'Start date in ISO 8601 format' })
  @IsOptional()
  @ValidateIf((o) => o.preset === DateRangePreset.CUSTOM)
  @IsISO8601()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date in ISO 8601 format' })
  @IsOptional()
  @ValidateIf((o) => o.preset === DateRangePreset.CUSTOM)
  @IsISO8601()
  endDate?: string;
}

export function getDateRangeFromPreset(preset: DateRangePreset): { startDate: Date; endDate: Date } {
  const now = new Date();
  const wibNow = toWIB(now);
  const today = startOfDayWIB(now);

  switch (preset) {
    case DateRangePreset.TODAY:
      return { startDate: today, endDate: endOfDayWIB(now) };
    case DateRangePreset.YESTERDAY: {
      const yesterday = wibNow.subtract(1, 'day').toDate();
      return { startDate: startOfDayWIB(yesterday), endDate: endOfDayWIB(yesterday) };
    }
    case DateRangePreset.LAST_7_DAYS:
      return { startDate: wibNow.subtract(7, 'day').startOf('day').toDate(), endDate: now };
    case DateRangePreset.LAST_30_DAYS:
      return { startDate: wibNow.subtract(30, 'day').startOf('day').toDate(), endDate: now };
    case DateRangePreset.THIS_MONTH:
      return { startDate: wibNow.startOf('month').toDate(), endDate: now };
    case DateRangePreset.LAST_MONTH: {
      const lastMonth = wibNow.subtract(1, 'month');
      return { startDate: lastMonth.startOf('month').toDate(), endDate: lastMonth.endOf('month').toDate() };
    }
    default:
      return { startDate: today, endDate: now };
  }
}
