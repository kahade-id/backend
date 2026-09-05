import { PipeTransform } from '@nestjs/common';
export declare class ParseSlugPipe implements PipeTransform<string, string> {
    transform(value: string): string;
}
