import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class ParseQueryStringPipe implements PipeTransform<string, string> {
  private readonly maxLength: number;
  private readonly paramName: string;

  constructor(paramName: string, maxLength = 200) {
    this.paramName = paramName;
    this.maxLength = maxLength;
  }

  transform(value: string): string {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string') {
      throw new BadRequestException(`${this.paramName} must be a string`);
    }
    if (value.length > this.maxLength) {
      throw new BadRequestException(`${this.paramName} exceeds maximum length of ${this.maxLength}`);
    }
    return value.replace(/[<>&"']/g, '');
  }
}

@Injectable()
export class ParseEnumQueryPipe implements PipeTransform<string, string> {
  private readonly allowed: Set<string>;
  private readonly paramName: string;

  constructor(paramName: string, allowedValues: string[]) {
    this.paramName = paramName;
    this.allowed = new Set(allowedValues);
  }

  transform(value: string): string {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string' || !this.allowed.has(value)) {
      throw new BadRequestException(`${this.paramName} must be one of: ${[...this.allowed].join(', ')}`);
    }
    return value;
  }
}

const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

@Injectable()
export class ParseDateQueryPipe implements PipeTransform<string, string> {
  private readonly paramName: string;

  constructor(paramName: string) {
    this.paramName = paramName;
  }

  transform(value: string): string {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'string' || value.length > 30) {
      throw new BadRequestException(`${this.paramName} must be a valid ISO 8601 date string`);
    }
    if (!ISO_8601_PATTERN.test(value)) {
      throw new BadRequestException(`${this.paramName} must be a valid ISO 8601 date (e.g. 2024-01-15 or 2024-01-15T10:30:00Z)`);
    }
    const d = new Date(value);
    if (isNaN(d.getTime())) {
      throw new BadRequestException(`${this.paramName} must be a valid date`);
    }
    return value;
  }
}

@Injectable()
export class ParsePagePipe implements PipeTransform<number, number> {
  transform(value: number): number {
    return Math.max(1, value);
  }
}
