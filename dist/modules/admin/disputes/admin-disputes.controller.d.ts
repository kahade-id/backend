import { Request } from 'express';
import { AdminJwtPayload } from '../../../common/types/jwt-payload.types';
import { AdminDisputesService } from './admin-disputes.service';
import { DisputeDecisionDto } from './dispute-decision.dto';
import { DisputeListQueryDto } from './dto/dispute-list-query.dto';
import { AssignDisputeDto } from './dto/assign-dispute.dto';
import { SendDisputeMessageDto } from './dto/send-dispute-message.dto';
export declare class AdminDisputesController {
    private readonly service;
    constructor(service: AdminDisputesService);
    listDisputes(query: DisputeListQueryDto): Promise<object>;
    getDetail(disputeId: string, admin: AdminJwtPayload, req: Request): Promise<object>;
    getDisputeMessages(disputeId: string, admin: AdminJwtPayload, cursor?: string, limit?: number): Promise<object>;
    sendDisputeMessage(disputeId: string, admin: AdminJwtPayload, dto: SendDisputeMessageDto, req: Request): Promise<object>;
    assignAdmin(disputeId: string, admin: AdminJwtPayload, dto: AssignDisputeDto, req: Request): Promise<object>;
    markUnderReview(disputeId: string, admin: AdminJwtPayload, req: Request): Promise<object>;
    resolve(disputeId: string, dto: DisputeDecisionDto, admin: AdminJwtPayload, req: Request): Promise<object>;
}
