import { PipeTransform } from '@nestjs/common';
export declare class ParseUsernamePipe implements PipeTransform<string, string> {
    transform(value: string): string;
}
