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
exports.ExportCsvDto = void 0;
const class_validator_1 = require("class-validator");
const date_util_1 = require("../../../common/utils/date.util");
let DateRangeLimitConstraint = class DateRangeLimitConstraint {
    validate(_, args) {
        const obj = args.object;
        if (!obj.from || !obj.to)
            return true;
        const fromDate = (0, date_util_1.parseDateBoundaryWIB)(obj.from, 'start');
        const toDate = (0, date_util_1.parseDateBoundaryWIB)(obj.to, 'end');
        if (!fromDate || !toDate)
            return false;
        const diffMs = toDate.getTime() - fromDate.getTime();
        const MAX_DAYS = 365;
        return diffMs >= 0 && diffMs <= MAX_DAYS * 24 * 60 * 60 * 1000;
    }
    defaultMessage() {
        return 'Date range must not exceed 365 days, and "to" must be after "from"';
    }
};
DateRangeLimitConstraint = __decorate([
    (0, class_validator_1.ValidatorConstraint)({ name: 'dateRangeLimit', async: false })
], DateRangeLimitConstraint);
class ExportCsvDto {
}
exports.ExportCsvDto = ExportCsvDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], ExportCsvDto.prototype, "from", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsDateString)(),
    (0, class_validator_1.Validate)(DateRangeLimitConstraint),
    __metadata("design:type", String)
], ExportCsvDto.prototype, "to", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsIn)(['csv', 'xlsx']),
    __metadata("design:type", String)
], ExportCsvDto.prototype, "format", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_validator_1.ArrayMaxSize)(10),
    __metadata("design:type", Array)
], ExportCsvDto.prototype, "types", void 0);
