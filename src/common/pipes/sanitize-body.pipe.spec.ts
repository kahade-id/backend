import { ArgumentMetadata } from '@nestjs/common';
import { SanitizeBodyPipe } from './sanitize-body.pipe';

const bodyMeta: ArgumentMetadata = { type: 'body', metatype: undefined, data: undefined };
const queryMeta: ArgumentMetadata = { type: 'query', metatype: undefined, data: undefined };

describe('SanitizeBodyPipe', () => {
  const pipe = new SanitizeBodyPipe();

  it('passes through non-body metadata unchanged', () => {
    const value = { a: '<script>alert(1)</script>' };
    expect(pipe.transform(value, queryMeta)).toBe(value);
  });

  it('strips obvious script tags', () => {
    const out = pipe.transform({ note: '<script>alert(1)</script>hello' }, bodyMeta) as { note: string };
    expect(out.note).toBe('hello');
  });

  it('strips nested script tag obfuscation in a fixed-point loop', () => {
    const payload = '<scr<script>ipt>alert(1)</scr</script>ipt>';
    const out = pipe.transform({ note: payload }, bodyMeta) as { note: string };
    expect(out.note.toLowerCase().includes('<script')).toBe(false);
    expect(out.note.toLowerCase().includes('</script')).toBe(false);
  });

  it('strips javascript: URI scheme', () => {
    const out = pipe.transform({ link: 'javascript:alert(1)' }, bodyMeta) as { link: string };
    expect(out.link.toLowerCase().includes('javascript:')).toBe(false);
  });

  it('strips event handlers, including backtick-quoted ones', () => {
    const out = pipe.transform(
      { html: '<img src=x onerror="alert(1)" onclick=`alert(1)` onload=alert(1)>' },
      bodyMeta,
    ) as { html: string };
    expect(out.html.toLowerCase().includes('onerror')).toBe(false);
    expect(out.html.toLowerCase().includes('onclick')).toBe(false);
    expect(out.html.toLowerCase().includes('onload')).toBe(false);
  });

  it('strips Unicode bidi-override characters', () => {
    const payload = `kahade\u202E.gnp.exe`; // RIGHT-TO-LEFT OVERRIDE
    const out = pipe.transform({ name: payload }, bodyMeta) as { name: string };
    expect(out.name.includes('\u202E')).toBe(false);
  });

  it('recurses into arrays and nested objects', () => {
    const out = pipe.transform(
      { items: [{ note: '<script>x</script>safe' }, 'javascript:x'] },
      bodyMeta,
    ) as { items: Array<{ note?: string } | string> };
    expect(out.items.length).toBe(2);
    expect((out.items[0] as { note: string }).note).toBe('safe');
    expect((out.items[1] as string).toLowerCase().includes('javascript:')).toBe(false);
  });

  it('leaves non-string primitives untouched', () => {
    const out = pipe.transform({ count: 5, ok: true, n: null }, bodyMeta) as Record<string, unknown>;
    expect(out.count).toBe(5);
    expect(out.ok).toBe(true);
    expect(out.n).toBeNull();
  });
});
