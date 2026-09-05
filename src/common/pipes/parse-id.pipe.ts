import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

const CUID_RE = /^c[a-z0-9]{24}$/;
const PREFIXED_ID_RE = /^[A-Z]{2,5}-[A-Za-z0-9_-]{3,80}$/;
const MAX_ID_LENGTH = 100;

const KNOWN_PREFIX_PATTERNS: Record<string, RegExp> = {
  USR: /^USR-[A-Za-z0-9_-]{8,40}$/,
  ORD: /^ORD-[A-Za-z0-9_-]{8,40}$/,
  TXN: /^TXN-[A-Za-z0-9_-]{8,40}$/,
  DSP: /^DSP-[A-Za-z0-9_-]{8,40}$/,
  WLT: /^WLT-[A-Za-z0-9_-]{8,40}$/,
  PRD: /^PRD-[A-Za-z0-9_-]{8,40}$/,
  SUB: /^SUB-[A-Za-z0-9_-]{8,40}$/,
  TKT: /^TKT-[A-Za-z0-9_-]{8,40}$/,
  ADM: /^ADM-[A-Za-z0-9_-]{8,40}$/,
};

@Injectable()
export class ParseIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
      throw new BadRequestException('Invalid ID format');
    }

    if (CUID_RE.test(value)) return value;

    const dashIdx = value.indexOf('-');
    if (dashIdx > 0) {
      const prefix = value.substring(0, dashIdx);
      const pattern = KNOWN_PREFIX_PATTERNS[prefix];
      if (pattern) {
        if (pattern.test(value)) return value;
        throw new BadRequestException(`Invalid ${prefix} ID format`);
      }
    }

    if (PREFIXED_ID_RE.test(value)) return value;

    throw new BadRequestException('Invalid ID format');
  }
}
