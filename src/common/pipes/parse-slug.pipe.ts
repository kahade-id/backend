import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

const SLUG_RE = /^[a-zA-Z0-9_-]{1,100}$/;

@Injectable()
export class ParseSlugPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !SLUG_RE.test(value)) {
      throw new BadRequestException('Invalid slug format');
    }
    return value;
  }
}
