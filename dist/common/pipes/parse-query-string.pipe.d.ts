import { PipeTransform } from '@nestjs/common';
export declare class ParseQueryStringPipe implements PipeTransform<string, string> {
    private readonly maxLength;
    private readonly paramName;
    constructor(paramName: string, maxLength?: number);
    transform(value: string): string;
}
export declare class ParseEnumQueryPipe implements PipeTransform<string, string> {
    private readonly allowed;
    private readonly paramName;
    constructor(paramName: string, allowedValues: string[]);
    transform(value: string): string;
}
export declare class ParseDateQueryPipe implements PipeTransform<string, string> {
    private readonly paramName;
    constructor(paramName: string);
    transform(value: string): string;
}
export declare class ParsePagePipe implements PipeTransform<number, number> {
    transform(value: number): number;
}
