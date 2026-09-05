import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';

/*
 * Defense-in-depth body sanitization.
 *
 * This pipe is **not** the primary XSS protection — output encoding at the
 * rendering layer is. It strips obvious script-injection vectors so that
 * dangerous payloads stored in user content (descriptions, names, etc.) are
 * unlikely to round-trip through clients that mis-render server data.
 *
 * The patterns are applied in a fixed-point loop because nested constructs
 * such as `<scr<script>ipt>` collapse only after one pass strips the outer
 * tag and exposes a fresh inner one.
 */
const SCRIPT_TAG_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const ORPHAN_SCRIPT_OPEN_RE = /<script\b[^>]*>/gi;
const ORPHAN_SCRIPT_CLOSE_RE = /<\/script\s*>/gi;
const EVENT_HANDLER_RE = /\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s>]*)/gi;
const JS_URI_RE = /javascript\s*:/gi;
const DATA_URI_RE = /data\s*:\s*text\/html/gi;
// Strip Unicode bidi-override characters that can mask homoglyph attacks in UI.
const BIDI_OVERRIDE_RE = /[\u202A-\u202E\u2066-\u2069]/g;
const MAX_PASSES = 5;

function stripXssPatterns(input: string): string {
  let prev = '';
  let next = input;
  let passes = 0;
  while (prev !== next && passes < MAX_PASSES) {
    prev = next;
    next = prev
      .replace(SCRIPT_TAG_RE, '')
      .replace(ORPHAN_SCRIPT_OPEN_RE, '')
      .replace(ORPHAN_SCRIPT_CLOSE_RE, '')
      .replace(EVENT_HANDLER_RE, '')
      .replace(JS_URI_RE, '')
      .replace(DATA_URI_RE, '')
      .replace(BIDI_OVERRIDE_RE, '');
    passes += 1;
  }
  return next;
}

@Injectable()
export class SanitizeBodyPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    return this.sanitize(value);
  }

  private sanitize(value: unknown): unknown {
    if (typeof value === 'string') {
      return stripXssPatterns(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitize(item));
    }
    if (value !== null && typeof value === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        sanitized[key] = this.sanitize(val);
      }
      return sanitized;
    }
    return value;
  }
}
