import { PipeTransform } from '@nestjs/common';
export declare class ClampLimitPipe implements PipeTransform {
    private readonly max;
    constructor(max?: number);
    transform(value: number): number;
}
