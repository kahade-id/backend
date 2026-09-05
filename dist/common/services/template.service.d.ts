import { OnModuleInit } from '@nestjs/common';
export declare class TemplateService implements OnModuleInit {
    private readonly logger;
    private readonly cache;
    private baseTemplate;
    private readonly templateDir;
    private resolveTemplateDir;
    onModuleInit(): void;
    render(templateName: string, context?: Record<string, unknown>): string;
    private static readonly ALLOWED_TEMPLATES;
    private getOrCompile;
}
