"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisputesController = exports.MutualResolutionRespondDto = exports.MutualResolutionProposeDto = exports.CallActionDto = exports.DisputeMessageDto = void 0;
const common_1 = require("@nestjs/common");
const parse_id_pipe_1 = require("../../common/pipes/parse-id.pipe");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const disputes_service_1 = require("./disputes.service");
const dispute_message_service_1 = require("./dispute-message.service");
const dispute_call_service_1 = require("./dispute-call.service");
const mutual_resolution_service_1 = require("./mutual-resolution.service");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const idempotency_decorator_1 = require("../../common/decorators/idempotency.decorator");
const pagination_dto_1 = require("../../common/dto/pagination.dto");
const user_throttle_guard_1 = require("../../common/guards/user-throttle.guard");
const submit_evidence_dto_1 = require("./dto/submit-evidence.dto");
const submit_claim_dto_1 = require("./dto/submit-claim.dto");
class DisputeMessageAttachmentDto {
}
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(512),
    (0, class_validator_1.Matches)(/^[^\u0000-\u001f]+$/),
    __metadata("design:type", String)
], DisputeMessageAttachmentDto.prototype, "fileKey", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(255),
    (0, class_validator_1.Matches)(/^[^\\/\u0000-\u001f]+$/),
    __metadata("design:type", String)
], DisputeMessageAttachmentDto.prototype, "fileName", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.IsIn)(submit_evidence_dto_1.ALLOWED_EVIDENCE_MIME_TYPES),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], DisputeMessageAttachmentDto.prototype, "fileType", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(10 * 1024 * 1024),
    __metadata("design:type", Number)
], DisputeMessageAttachmentDto.prototype, "fileSize", void 0);
class DisputeMessageDto {
}
exports.DisputeMessageDto = DisputeMessageDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(5000),
    __metadata("design:type", String)
], DisputeMessageDto.prototype, "message", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMaxSize)(5),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => DisputeMessageAttachmentDto),
    __metadata("design:type", Array)
], DisputeMessageDto.prototype, "attachments", void 0);
class CallActionDto {
}
exports.CallActionDto = CallActionDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(100),
    __metadata("design:type", String)
], CallActionDto.prototype, "callId", void 0);
class MutualResolutionProposeDto {
}
exports.MutualResolutionProposeDto = MutualResolutionProposeDto;
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], MutualResolutionProposeDto.prototype, "buyerPercent", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], MutualResolutionProposeDto.prototype, "sellerPercent", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.Matches)(/\S/, { message: 'Reason must contain at least one non-whitespace character' }),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], MutualResolutionProposeDto.prototype, "reason", void 0);
class MutualResolutionRespondDto {
}
exports.MutualResolutionRespondDto = MutualResolutionRespondDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.IsIn)(['ACCEPT', 'REJECT']),
    __metadata("design:type", String)
], MutualResolutionRespondDto.prototype, "action", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(2000),
    __metadata("design:type", String)
], MutualResolutionRespondDto.prototype, "responseNote", void 0);
let DisputesController = class DisputesController {
    constructor(disputesService, disputeMessageService, disputeCallService, mutualResolutionService) {
        this.disputesService = disputesService;
        this.disputeMessageService = disputeMessageService;
        this.disputeCallService = disputeCallService;
        this.mutualResolutionService = mutualResolutionService;
    }
    async listMyDisputes(userId, pagination) {
        return this.disputesService.listMyDisputes(userId, pagination.page, pagination.limit);
    }
    async getDisputeDetail(userId, disputeId) {
        return this.disputesService.getDisputeDetail(disputeId, userId);
    }
    async listEvidence(userId, disputeId, pagination) {
        return this.disputesService.listEvidence(disputeId, userId, pagination.page ?? 1, pagination.limit ?? 20);
    }
    async submitEvidence(userId, disputeId, dto) {
        return this.disputesService.submitEvidence(disputeId, userId, dto);
    }
    async deleteEvidence(userId, disputeId, evidenceId) {
        return this.disputesService.deleteEvidence(disputeId, evidenceId, userId);
    }
    async submitClaim(userId, disputeId, dto) {
        return this.disputesService.submitClaim(disputeId, userId, dto);
    }
    async getDisputeMessages(userId, disputeId, pagination) {
        return this.disputeMessageService.getMessages(disputeId, userId, pagination.page ?? 1, pagination.limit ?? 50);
    }
    async sendDisputeMessage(userId, disputeId, dto) {
        return this.disputeMessageService.sendMessage(disputeId, userId, dto.message || '', dto.attachments);
    }
    async requestCall(userId, disputeId) {
        return this.disputeCallService.requestCall(disputeId, userId);
    }
    async acceptCall(userId, disputeId, dto) {
        return this.disputeCallService.acceptCall(disputeId, userId, dto.callId);
    }
    async rejectCall(userId, disputeId, dto) {
        return this.disputeCallService.rejectCall(disputeId, userId, dto.callId);
    }
    async endCall(userId, disputeId, dto) {
        return this.disputeCallService.endCall(disputeId, userId, dto.callId);
    }
    async getCallHistory(userId, disputeId, pagination) {
        return this.disputeCallService.getCallHistory(disputeId, userId, pagination.page ?? 1, pagination.limit ?? 20);
    }
    async getMutualResolutionProposals(userId, disputeId, pagination) {
        return this.mutualResolutionService.getProposals(disputeId, userId, pagination.page ?? 1, pagination.limit ?? 20);
    }
    async proposeMutualResolution(userId, disputeId, dto) {
        return this.mutualResolutionService.propose(disputeId, userId, dto);
    }
    async respondMutualResolution(userId, disputeId, proposalId, dto) {
        return this.mutualResolutionService.respond(disputeId, proposalId, userId, dto.action, dto.responseNote);
    }
    async withdrawMutualResolution(userId, disputeId, proposalId) {
        return this.mutualResolutionService.withdraw(disputeId, proposalId, userId);
    }
};
exports.DisputesController = DisputesController;
__decorate([
    (0, common_1.Get)('my'),
    (0, swagger_1.ApiOperation)({ summary: 'List my disputes' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "listMyDisputes", null);
__decorate([
    (0, common_1.Get)(':disputeId'),
    (0, swagger_1.ApiOperation)({ summary: 'Get dispute detail' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "getDisputeDetail", null);
__decorate([
    (0, common_1.Get)(':disputeId/evidence'),
    (0, swagger_1.ApiOperation)({ summary: 'List dispute evidence with pagination' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "listEvidence", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':disputeId/evidence'),
    (0, swagger_1.ApiOperation)({ summary: 'Submit dispute evidence (batch, per-file validation)' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, submit_evidence_dto_1.SubmitEvidenceDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "submitEvidence", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Delete)(':disputeId/evidence/:evidenceId'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Delete own dispute evidence' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Param)('evidenceId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "deleteEvidence", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 5 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':disputeId/claim'),
    (0, swagger_1.ApiOperation)({ summary: 'Submit or update claim text' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, submit_claim_dto_1.SubmitClaimDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "submitClaim", null);
__decorate([
    (0, common_1.Get)(':disputeId/messages'),
    (0, swagger_1.ApiOperation)({ summary: 'Get dispute messages' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "getDisputeMessages", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 20 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':disputeId/messages'),
    (0, swagger_1.ApiOperation)({ summary: 'Send a dispute message' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, DisputeMessageDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "sendDisputeMessage", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':disputeId/call/request'),
    (0, swagger_1.ApiOperation)({ summary: 'Request a video call in a dispute' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "requestCall", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':disputeId/call/accept'),
    (0, swagger_1.ApiOperation)({ summary: 'Accept a video call request' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, CallActionDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "acceptCall", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 5 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':disputeId/call/reject'),
    (0, swagger_1.ApiOperation)({ summary: 'Reject a video call request' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, CallActionDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "rejectCall", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 60000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':disputeId/call/end'),
    (0, swagger_1.ApiOperation)({ summary: 'End an active video call' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, CallActionDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "endCall", null);
__decorate([
    (0, common_1.Get)(':disputeId/calls'),
    (0, swagger_1.ApiOperation)({ summary: 'Get call history for a dispute' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "getCallHistory", null);
__decorate([
    (0, common_1.Get)(':disputeId/mutual-resolution'),
    (0, swagger_1.ApiOperation)({ summary: 'Get mutual resolution proposals' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, pagination_dto_1.PaginationDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "getMutualResolutionProposals", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':disputeId/mutual-resolution'),
    (0, swagger_1.ApiOperation)({ summary: 'Propose a mutual resolution' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, MutualResolutionProposeDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "proposeMutualResolution", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Post)(':disputeId/mutual-resolution/:proposalId/respond'),
    (0, swagger_1.ApiOperation)({ summary: 'Accept or reject a mutual resolution proposal' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Param)('proposalId', parse_id_pipe_1.ParseIdPipe)),
    __param(3, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, MutualResolutionRespondDto]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "respondMutualResolution", null);
__decorate([
    (0, common_1.UseGuards)(user_throttle_guard_1.UserThrottleGuard),
    (0, throttler_1.Throttle)({ default: { ttl: 900000, limit: 10 } }),
    (0, idempotency_decorator_1.Idempotency)(),
    (0, common_1.Delete)(':disputeId/mutual-resolution/:proposalId'),
    (0, common_1.HttpCode)(200),
    (0, swagger_1.ApiOperation)({ summary: 'Withdraw own pending proposal' }),
    __param(0, (0, current_user_decorator_1.CurrentUser)('sub')),
    __param(1, (0, common_1.Param)('disputeId', parse_id_pipe_1.ParseIdPipe)),
    __param(2, (0, common_1.Param)('proposalId', parse_id_pipe_1.ParseIdPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String]),
    __metadata("design:returntype", Promise)
], DisputesController.prototype, "withdrawMutualResolution", null);
exports.DisputesController = DisputesController = __decorate([
    (0, swagger_1.ApiTags)('disputes'),
    (0, swagger_1.ApiBearerAuth)('access-token'),
    (0, common_1.Controller)('disputes'),
    __metadata("design:paramtypes", [disputes_service_1.DisputesService,
        dispute_message_service_1.DisputeMessageService,
        dispute_call_service_1.DisputeCallService,
        mutual_resolution_service_1.MutualResolutionService])
], DisputesController);
