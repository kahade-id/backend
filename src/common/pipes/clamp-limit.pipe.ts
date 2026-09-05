import { PipeTransform, Injectable } from '@nestjs/common';

@Injectable()
export class ClampLimitPipe implements PipeTransform {
  private readonly max: number;

  constructor(max = 100) {
    this.max = max;
  }

  transform(value: number): number {
    return Math.min(Math.max(1, value), this.max);
  }
}
