import { ExceptionFilter, ArgumentsHost } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
export declare class AllExceptionsFilter implements ExceptionFilter {
    private readonly configService;
    private readonly logger;
    constructor(configService: ConfigService);
    catch(exception: unknown, host: ArgumentsHost): void;
}
