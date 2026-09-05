import { AdminManagementService } from './admin-management.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { Request } from 'express';
export declare class AdminManagementController {
    private readonly service;
    constructor(service: AdminManagementService);
    listAdmins(pagination: PaginationDto, search?: string): Promise<object>;
    getAdmin(id: string): Promise<object>;
    createAdmin(dto: CreateAdminDto, adminId: string, req: Request): Promise<object>;
    updateAdmin(id: string, dto: UpdateAdminDto, adminId: string, req: Request): Promise<object>;
    resetAdmin2fa(id: string, adminId: string, req: Request): Promise<{
        message: string;
    }>;
    unlockAdmin(id: string, adminId: string, req: Request): Promise<{
        message: string;
    }>;
    deleteAdmin(id: string, adminId: string, req: Request): Promise<{
        message: string;
    }>;
}
