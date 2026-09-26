import { sanitizeShowcaseHtml } from './sanitize-html.util';

describe('sanitizeShowcaseHtml (Kahade+ Benefit 7)', () => {
  it('mempertahankan tag allowlist', () => {
    expect(sanitizeShowcaseHtml('<p>Halo <b>dunia</b></p>')).toBe('<p>Halo <b>dunia</b></p>');
    expect(sanitizeShowcaseHtml('<ul><li>a</li><li>b</li></ul>')).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('menghapus <script>/<style>/<iframe> beserta isinya', () => {
    expect(sanitizeShowcaseHtml('<script>alert(1)</script><p>ok</p>')).toBe('<p>ok</p>');
    expect(sanitizeShowcaseHtml('<style>p{color:red}</style><p>ok</p>')).toBe('<p>ok</p>');
  });

  it('membuang javascript: href tapi mempertahankan tag <a>', () => {
    expect(sanitizeShowcaseHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeShowcaseHtml('<a href="https://kahade.id">x</a>')).toBe('<a href="https://kahade.id">x</a>');
  });

  it('menghapus event handler dan atribut style', () => {
    expect(sanitizeShowcaseHtml('<p onclick="evil()">x</p>')).toBe('<p>x</p>');
    expect(sanitizeShowcaseHtml('<p style="color:red">x</p>')).toBe('<p>x</p>');
  });

  it('membuang tag tak dikenal tapi menyimpan isi teksnya', () => {
    expect(sanitizeShowcaseHtml('<div>teks</div>')).toBe('teks');
    expect(sanitizeShowcaseHtml('<img src=x onerror=alert(1)>')).toBe('');
  });

  it('idempoten', () => {
    const once = sanitizeShowcaseHtml('<p><b>x</b></p><script>y</script>');
    expect(sanitizeShowcaseHtml(once)).toBe(once);
  });
});
