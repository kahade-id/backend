import { NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
export declare class PaginationClampInterceptor implements NestInterceptor {
    private readonly maxLimit;
    constructor(maxLimit?: number);
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown>;
}
