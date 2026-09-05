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
exports.DateRangeDto = exports.DateRangePreset = void 0;
exports.getDateRangeFromPreset = getDateRangeFromPreset;
const class_validator_1 = require("class-validator");
const swagger_1 = require("@nestjs/swagger");
const date_util_1 = require("../utils/date.util");
var DateRangePreset;
(function (DateRangePreset) {
    DateRangePreset["TODAY"] = "today";
    DateRangePreset["YESTERDAY"] = "yesterday";
    DateRangePreset["LAST_7_DAYS"] = "last_7_days";
    DateRangePreset["LAST_30_DAYS"] = "last_30_days";
    DateRangePreset["THIS_MONTH"] = "this_month";
    DateRangePreset["LAST_MONTH"] = "last_month";
    DateRangePreset["CUSTOM"] = "custom";
})(DateRangePreset || (exports.DateRangePreset = DateRangePreset = {}));
class DateRangeDto {
}
exports.DateRangeDto = DateRangeDto;
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ enum: DateRangePreset }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(DateRangePreset),
    __metadata("design:type", String)
], DateRangeDto.prototype, "preset", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'Start date in ISO 8601 format' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.ValidateIf)((o) => o.preset === DateRangePreset.CUSTOM),
    (0, class_validator_1.IsISO8601)(),
    __metadata("design:type", String)
], DateRangeDto.prototype, "startDate", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({ description: 'End date in ISO 8601 format' }),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.ValidateIf)((o) => o.preset === DateRangePreset.CUSTOM),
    (0, class_validator_1.IsISO8601)(),
    __metadata("design:type", String)
], DateRangeDto.prototype, "endDate", void 0);
function getDateRangeFromPreset(preset) {
    const now = new Date();
    const wibNow = (0, date_util_1.toWIB)(now);
    const today = (0, date_util_1.startOfDayWIB)(now);
    switch (preset) {
        case DateRangePreset.TODAY:
            return { startDate: today, endDate: (0, date_util_1.endOfDayWIB)(now) };
        case DateRangePreset.YESTERDAY: {
            const yesterday = wibNow.subtract(1, 'day').toDate();
            return { startDate: (0, date_util_1.startOfDayWIB)(yesterday), endDate: (0, date_util_1.endOfDayWIB)(yesterday) };
        }
        case DateRangePreset.LAST_7_DAYS:
            return { startDate: wibNow.subtract(7, 'day').startOf('day').toDate(), endDate: now };
        case DateRangePreset.LAST_30_DAYS:
            return { startDate: wibNow.subtract(30, 'day').startOf('day').toDate(), endDate: now };
        case DateRangePreset.THIS_MONTH:
            return { startDate: wibNow.startOf('month').toDate(), endDate: now };
        case DateRangePreset.LAST_MONTH: {
            const lastMonth = wibNow.subtract(1, 'month');
            return { startDate: lastMonth.startOf('month').toDate(), endDate: lastMonth.endOf('month').toDate() };
        }
        default:
            return { startDate: today, endDate: now };
    }
}
