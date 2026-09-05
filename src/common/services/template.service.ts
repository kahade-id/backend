import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as Handlebars from 'handlebars';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class TemplateService implements OnModuleInit {
  private readonly logger = new Logger(TemplateService.name);
  private readonly cache = new Map<string, Handlebars.TemplateDelegate>();
  private baseTemplate!: Handlebars.TemplateDelegate;
  private readonly templateDir = this.resolveTemplateDir();

  private resolveTemplateDir(): string {
    const distPath = path.join(__dirname, '..', '..', 'templates', 'email');
    if (fs.existsSync(distPath)) return distPath;
    return path.join(process.cwd(), 'src', 'templates', 'email');
  }

  onModuleInit(): void {
    const basePath = path.join(this.templateDir, 'base.hbs');
    if (!fs.existsSync(basePath)) {
      this.logger.warn('base.hbs not found — emails will render without layout wrapper');
      this.baseTemplate = Handlebars.compile('{{{content}}}');
      return;
    }
    const baseSource = fs.readFileSync(basePath, 'utf-8');
    this.baseTemplate = Handlebars.compile(baseSource);
    this.logger.log('Email base template loaded');
  }

  render(templateName: string, context: Record<string, unknown> = {}): string {
    const compiled = this.getOrCompile(templateName);
    const innerHtml = compiled(context);
    return this.baseTemplate({ ...context, content: new Handlebars.SafeString(innerHtml) });
  }

  private static readonly ALLOWED_TEMPLATES = new Set([
    'email-verification', 'verify-email', 'password-reset', 'password-reset-confirm',
    'welcome', 'order-created', 'order-accepted', 'order-rejected', 'order-completed',
    'order-cancelled', 'order-shipped', 'order-payment', 'dispute-submitted',
    'dispute-decision', 'topup-success', 'withdraw-success', 'withdraw-failed',
    'withdrawal-otp', 'email-changed', 'email-changed-old', 'email-changed-notification',
    'two-fa-enabled', 'two-fa-disabled', '2fa-disable', 'subscription', 'subscription-renewed',
    'subscription-renewal-failed', 'kyc-approved', 'kyc-rejected', 'login-alert',
    'new-device-login', 'account-locked', 'account-suspended', 'admin-password-reset',
    'backup-code-used', 'data-export',
    'transfer-sent',
    'transfer-received',
  ]);

  private getOrCompile(templateName: string): Handlebars.TemplateDelegate {
    const baseName = path.basename(templateName, '.hbs');
    if (!TemplateService.ALLOWED_TEMPLATES.has(baseName)) {
      throw new Error(`Template "${templateName}" is not in the allowlist`);
    }

    const cached = this.cache.get(baseName);
    if (cached) return cached;

    const filePath = path.join(this.templateDir, `${baseName}.hbs`);
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(this.templateDir))) {
      throw new Error(`Template path traversal attempt blocked: "${templateName}"`);
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`Email template "${baseName}" not found at ${filePath}`);
    }

    const source = fs.readFileSync(filePath, 'utf-8');
    const compiled = Handlebars.compile(source);
    this.cache.set(baseName, compiled);
    return compiled;
  }
}
