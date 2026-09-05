import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CsrfService } from '../services/csrf.service';
export declare class CsrfGuard implements CanActivate {
    private csrfService;
    private reflector;
    constructor(csrfService: CsrfService, reflector: Reflector);
    canActivate(context: ExecutionContext): Promise<boolean>;
}
