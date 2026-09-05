import { PipeTransform, ArgumentMetadata } from '@nestjs/common';
export declare class SanitizeBodyPipe implements PipeTransform {
    transform(value: unknown, metadata: ArgumentMetadata): unknown;
    private sanitize;
}
