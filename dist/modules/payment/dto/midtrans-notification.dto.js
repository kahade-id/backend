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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MidtransNotificationDto = void 0;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
class MidtransNotificationDto {
}
exports.MidtransNotificationDto = MidtransNotificationDto;
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Order ID from Midtrans' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(255),
    __metadata("design:type", String)
], MidtransNotificationDto.prototype, "order_id", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Status code' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(10),
    (0, class_validator_1.Matches)(/^\d{3}$/),
    __metadata("design:type", String)
], MidtransNotificationDto.prototype, "status_code", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Gross amount' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(50),
    (0, class_validator_1.Matches)(/^\d+(?:\.\d{1,2})?$/),
    __metadata("design:type", String)
], MidtransNotificationDto.prototype, "gross_amount", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Signature key for verification' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(512),
    __metadata("design:type", String)
], MidtransNotificationDto.prototype, "signature_key", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Transaction status' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], MidtransNotificationDto.prototype, "transaction_status", void 0);
__decorate([
    (0, swagger_1.ApiProperty)({ description: 'Transaction ID' }),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(255),
    (0, class_validator_1.Matches)(/\S/),
    __metadata("design:type", String)
], MidtransNotificationDto.prototype, "transaction_id", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Payment type' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], MidtransNotificationDto.prototype, "payment_type", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Fraud status' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(50),
    __metadata("design:type", String)
], MidtransNotificationDto.prototype, "fraud_status", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Cumulative amount refunded by Midtrans, for refund and partial_refund notifications' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(50),
    (0, class_validator_1.Matches)(/^\d+(?:\.\d{1,2})?$/),
    __metadata("design:type", String)
], MidtransNotificationDto.prototype, "refund_amount", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Merchant refund reference used to make refund webhook delivery idempotent' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(255),
    (0, class_validator_1.Matches)(/\S/),
    __metadata("design:type", String)
], MidtransNotificationDto.prototype, "refund_key", void 0);
