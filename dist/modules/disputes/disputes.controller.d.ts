import { DisputeEvidence } from '@prisma/client';
import { DisputesService } from './disputes.service';
import { DisputeMessageService } from './dispute-message.service';
import { DisputeCallService } from './dispute-call.service';
import { MutualResolutionService } from './mutual-resolution.service';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
import { SubmitEvidenceDto } from './dto/submit-evidence.dto';
import { SubmitClaimDto } from './dto/submit-claim.dto';
declare class DisputeMessageAttachmentDto {
    fileKey: string;
    fileName: string;
    fileType: string;
    fileSize: number;
}
export declare class DisputeMessageDto {
    message?: string;
    attachments?: DisputeMessageAttachmentDto[];
}
export declare class CallActionDto {
    callId: string;
}
export declare class MutualResolutionProposeDto {
    buyerPercent: number;
    sellerPercent: number;
    reason: string;
}
export declare class MutualResolutionRespondDto {
    action: 'ACCEPT' | 'REJECT';
    responseNote?: string;
}
export declare class DisputesController {
    private disputesService;
    private disputeMessageService;
    private disputeCallService;
    private mutualResolutionService;
    constructor(disputesService: DisputesService, disputeMessageService: DisputeMessageService, disputeCallService: DisputeCallService, mutualResolutionService: MutualResolutionService);
    listMyDisputes(userId: string, pagination: PaginationDto): Promise<PaginatedResponse<Record<string, unknown>>>;
    getDisputeDetail(userId: string, disputeId: string): Promise<Record<string, unknown>>;
    listEvidence(userId: string, disputeId: string, pagination: PaginationDto): Promise<PaginatedResponse<DisputeEvidence>>;
    submitEvidence(userId: string, disputeId: string, dto: SubmitEvidenceDto): Promise<{
        evidence: DisputeEvidence | null;
        fileResults: {
            fileKey: string;
            fileType: string;
            status: string;
            error?: string;
        }[];
        summary: {
            total: number;
            succeeded: number;
            failed: number;
        };
    }>;
    deleteEvidence(userId: string, disputeId: string, evidenceId: string): Promise<{
        deleted: boolean;
    }>;
    submitClaim(userId: string, disputeId: string, dto: SubmitClaimDto): Promise<Record<string, unknown>>;
    getDisputeMessages(userId: string, disputeId: string, pagination: PaginationDto): Promise<object>;
    sendDisputeMessage(userId: string, disputeId: string, dto: DisputeMessageDto): Promise<object>;
    requestCall(userId: string, disputeId: string): Promise<object>;
    acceptCall(userId: string, disputeId: string, dto: CallActionDto): Promise<object>;
    rejectCall(userId: string, disputeId: string, dto: CallActionDto): Promise<object>;
    endCall(userId: string, disputeId: string, dto: CallActionDto): Promise<object>;
    getCallHistory(userId: string, disputeId: string, pagination: PaginationDto): Promise<object>;
    getMutualResolutionProposals(userId: string, disputeId: string, pagination: PaginationDto): Promise<object>;
    proposeMutualResolution(userId: string, disputeId: string, dto: MutualResolutionProposeDto): Promise<object>;
    respondMutualResolution(userId: string, disputeId: string, proposalId: string, dto: MutualResolutionRespondDto): Promise<object>;
    withdrawMutualResolution(userId: string, disputeId: string, proposalId: string): Promise<{
        status: string;
    }>;
}
export {};
