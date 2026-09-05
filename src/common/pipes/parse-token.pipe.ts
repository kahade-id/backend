import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

const TOKEN_RE = /^[a-zA-Z0-9_-]{10,128}$/;

@Injectable()
export class ParseTokenPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
      throw new BadRequestException('Invalid token format');
    }
    return value;
  }
}
