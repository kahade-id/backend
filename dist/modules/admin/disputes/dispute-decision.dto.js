"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DisputeDecisionDto = void 0;
exports.validateSplitPercents = validateSplitPercents;
const class_validator_1 = require("class-validator");
const common_1 = require("@nestjs/common");
const ErrorCodes = __importStar(require("../../../common/constants/error-codes"));
const swagger_1 = require("@nestjs/swagger");
class DisputeDecisionDto {
}
exports.DisputeDecisionDto = DisputeDecisionDto;
__decorate([
    (0, swagger_1.ApiProperty)({ enum: ['FULL_BUYER', 'FULL_SELLER', 'SPLIT'], description: 'Dispute decision' }),
    (0, class_validator_1.IsEnum)(['FULL_BUYER', 'FULL_SELLER', 'SPLIT']),
    __metadata("design:type", String)
], DisputeDecisionDto.prototype, "decision", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Decision notes for audit documentation', minLength: 100, maxLength: 5000 }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(100, { message: 'Decision notes must be at least 100 characters to ensure adequate audit documentation' }),
    (0, class_validator_1.Matches)(/\S/, { message: 'Decision notes must contain at least one non-whitespace character' }),
    (0, class_validator_1.MaxLength)(5000),
    __metadata("design:type", String)
], DisputeDecisionDto.prototype, "decisionNotes", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Buyer percentage for SPLIT decisions (integer 1–99)', minimum: 1, maximum: 99 }),
    (0, class_validator_1.ValidateIf)(o => o.decision === 'SPLIT'),
    (0, class_validator_1.IsInt)({ message: 'buyerPercent must be an integer' }),
    (0, class_validator_1.Min)(1, { message: 'buyerPercent must be at least 1 for a SPLIT decision' }),
    (0, class_validator_1.Max)(99, { message: 'buyerPercent must be at most 99 for a SPLIT decision (use FULL_BUYER for 100%)' }),
    __metadata("design:type", Number)
], DisputeDecisionDto.prototype, "buyerPercent", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Seller percentage for SPLIT decisions (integer 1–99)', minimum: 1, maximum: 99 }),
    (0, class_validator_1.ValidateIf)(o => o.decision === 'SPLIT'),
    (0, class_validator_1.IsInt)({ message: 'sellerPercent must be an integer' }),
    (0, class_validator_1.Min)(1, { message: 'sellerPercent must be at least 1 for a SPLIT decision' }),
    (0, class_validator_1.Max)(99, { message: 'sellerPercent must be at most 99 for a SPLIT decision (use FULL_SELLER for 100%)' }),
    __metadata("design:type", Number)
], DisputeDecisionDto.prototype, "sellerPercent", void 0);
function validateSplitPercents(dto) {
    if (dto.decision === 'SPLIT') {
        const buyer = dto.buyerPercent ?? 0;
        const seller = dto.sellerPercent ?? 0;
        if (buyer + seller !== 100) {
            throw new common_1.BadRequestException({
                code: ErrorCodes.INVALID_SPLIT_PERCENT,
                message: `SPLIT decision requires buyerPercent + sellerPercent = 100, got ${buyer} + ${seller} = ${buyer + seller}`,
            });
        }
    }
}
