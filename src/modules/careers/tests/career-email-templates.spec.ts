import { TemplateService } from '../../../common/services/template.service';
import {
  CAREER_EMAIL_TEMPLATES,
  CareerEmailContext,
  DEFAULT_CAREER_URL,
} from '../career-email';

describe('career email templates', () => {
  let service: TemplateService;

  beforeAll(() => {
    service = new TemplateService();
    service.onModuleInit();
  });

  const baseCtx: CareerEmailContext = {
    fullName: 'Budi Santoso',
    jobTitle: 'Co-Founder / COO',
    careerUrl: DEFAULT_CAREER_URL,
  };

  const render = (template: string, ctx: Record<string, unknown> = {}) =>
    service.render(template, { ...baseCtx, ...ctx, subject: 'test', year: 2026 });

  it.each([
    [CAREER_EMAIL_TEMPLATES.APPLICATION_RECEIVED, ['sudah kami terima', 'token penghapusan']],
    [CAREER_EMAIL_TEMPLATES.STATUS_REVIEW, ['sedang kami tinjau']],
    [CAREER_EMAIL_TEMPLATES.STATUS_INTERVIEW, ['wawancara']],
    [CAREER_EMAIL_TEMPLATES.STATUS_ACCEPTED, ['diterima']],
    [CAREER_EMAIL_TEMPLATES.STATUS_REJECTED, ['boleh melamar lagi', '90 hari', 'token penghapusan']],
  ])('renders %s with expected copy', (template, phrases) => {
    const html = render(template as string);
    // Base layout wrapper
    expect(html).toContain('KAHADE');
    // Personalization
    expect(html).toContain('Budi Santoso');
    expect(html).toContain('Co-Founder / COO');
    for (const phrase of phrases as string[]) {
      expect(html).toContain(phrase);
    }
  });

  it.each(Object.values(CAREER_EMAIL_TEMPLATES))(
    'has Kahade brand header (%s)',
    (template) => {
      const html = render(template);
      // Yellow zigzag mark, absolute URL (no relative/CID paths)
      expect(html).toContain('https://kahade.id/logo-mark-yellow.svg');
      expect(html).not.toMatch(/src="(?!https?:\/\/)[^"]*logo[^"]*"/);
    },
  );

  it.each(Object.values(CAREER_EMAIL_TEMPLATES))(
    'has career footer with retention info (%s)',
    (template) => {
      const html = render(template);
      expect(html).toContain('karir.kahade.id');
      expect(html).toContain('PT Kawal Hak Dengan Aman');
    },
  );

  it('received email has black CTA button linking to career site', () => {
    const html = render(CAREER_EMAIL_TEMPLATES.APPLICATION_RECEIVED);
    expect(html).toContain('class="btn"');
    expect(html).toContain(`href="${DEFAULT_CAREER_URL}"`);
  });

  it('renders optional interview note when provided', () => {
    const html = render(CAREER_EMAIL_TEMPLATES.STATUS_INTERVIEW, {
      interviewNote: 'Senin, 10 Okt pukul 14.00 WIB via Google Meet',
    });
    expect(html).toContain('Senin, 10 Okt pukul 14.00 WIB via Google Meet');
  });

  it('omits optional blocks when not provided', () => {
    const html = render(CAREER_EMAIL_TEMPLATES.STATUS_INTERVIEW);
    expect(html).not.toContain('Catatan:');
  });

  it('shows support email in rejected template when provided', () => {
    const html = render(CAREER_EMAIL_TEMPLATES.STATUS_REJECTED, {
      supportEmail: 'halo@kahade.id',
    });
    expect(html).toContain('halo@kahade.id');
  });

  it('rejects unknown template names (allowlist)', () => {
    expect(() =>
      service.render('career-nonexistent', { subject: 'x', year: 2026 }),
    ).toThrow();
  });
});
