import { Request } from 'express';
import { AdminOrdersService } from './admin-orders.service';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
import { AdminOrderQueryDto, ForceActionDto } from './dto/admin-order-query.dto';
export declare class AdminOrdersController {
    private readonly service;
    constructor(service: AdminOrdersService);
    listOrders(query: AdminOrderQueryDto): Promise<PaginatedResponse<Record<string, unknown>>>;
    getOrderDetail(orderId: string): Promise<Record<string, unknown>>;
    forceCancel(orderId: string, dto: ForceActionDto, adminId: string, req: Request): Promise<{
        orderId: string;
        status: string;
    }>;
    forceComplete(orderId: string, dto: ForceActionDto, adminId: string, req: Request): Promise<{
        orderId: string;
        status: string;
    }>;
}
