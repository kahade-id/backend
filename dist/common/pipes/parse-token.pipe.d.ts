import { PipeTransform } from '@nestjs/common';
export declare class ParseTokenPipe implements PipeTransform<string, string> {
    transform(value: string): string;
}
