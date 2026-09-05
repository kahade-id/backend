import { NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
export interface ApiResponse<T> {
    success: boolean;
    message: string;
    data: T | null;
    errors: null;
}
export declare class ResponseTransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
    private readonly reflector;
    constructor(reflector: Reflector);
    intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T>>;
    private static readonly MAX_DEPTH;
    private serializeBigInt;
}
