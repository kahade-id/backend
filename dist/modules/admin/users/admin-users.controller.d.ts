import { Request } from 'express';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { AdminUsersService } from './admin-users.service';
import { UserListQueryDto } from './dto/user-list-query.dto';
import { UserOrderQueryDto } from './dto/user-order-query.dto';
import { BanUserDto } from './dto/ban-user.dto';
import { WalletAdjustDto } from './dto/wallet-adjust.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
export declare class AdminUsersController {
    private readonly service;
    constructor(service: AdminUsersService);
    listUsers(query: UserListQueryDto): Promise<object>;
    getUserDetail(userId: string, admin: AdminJwtPayload, req: Request): Promise<object>;
    getUserOrders(userId: string, query: UserOrderQueryDto, admin: AdminJwtPayload, req: Request): Promise<object>;
    getUserWallet(userId: string, admin: AdminJwtPayload, req: Request): Promise<object>;
    getUserSessions(userId: string, pagination: PaginationDto, admin: AdminJwtPayload, req: Request): Promise<object>;
    adjustWallet(userId: string, dto: WalletAdjustDto, admin: AdminJwtPayload, req: Request): Promise<{
        txId: string;
        type: string;
        amount: number;
        reason: string;
        balanceAfter: number;
    }>;
    getUserAuditLog(userId: string, pagination: PaginationDto, admin: AdminJwtPayload, req: Request): Promise<object>;
    resetUserPassword(userId: string, admin: AdminJwtPayload, req: Request): Promise<{
        message: string;
    }>;
    forceLogout(userId: string, admin: AdminJwtPayload, req: Request): Promise<{
        message: string;
        revokedCount: number;
    }>;
    revokeUserSession(userId: string, sessionId: string, admin: AdminJwtPayload, req: Request): Promise<{
        message: string;
    }>;
    banUser(userId: string, dto: BanUserDto, admin: AdminJwtPayload, req: Request): Promise<object>;
    unbanUser(userId: string, admin: AdminJwtPayload, req: Request): Promise<object>;
}
