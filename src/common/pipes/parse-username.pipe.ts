import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

// B-17 (audit-fix): username MUST start with [a-z0-9] (lowercase per the
// existing system) -- a leading dot or underscore lets a username look like a
// hidden file ("/users/.env") which is dangerous on file-system-mapped routes
// or in audit-log greps. Trailing dot is also rejected.
// Allow letters, digits, underscore, dash, and *internal* dots.
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]|\.(?=[a-zA-Z0-9])){2,29}$/;

@Injectable()
export class ParseUsernamePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !USERNAME_RE.test(value)) {
      throw new BadRequestException('Invalid username format');
    }
    return value;
  }
}
