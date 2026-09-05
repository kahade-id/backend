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
var ReconciliationProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReconciliationProcessor = exports.RECONCILIATION_QUEUE = void 0;
const bull_1 = require("@nestjs/bull");
const common_1 = require("@nestjs/common");
const reconciliation_service_1 = require("./reconciliation.service");
exports.RECONCILIATION_QUEUE = 'reconciliation';
let ReconciliationProcessor = ReconciliationProcessor_1 = class ReconciliationProcessor {
    constructor(reconciliationService) {
        this.reconciliationService = reconciliationService;
        this.logger = new common_1.Logger(ReconciliationProcessor_1.name);
    }
    async handleReconcileAll(job) {
        this.logger.log(`Starting reconcile-all job ${job.id} (requested by ${job.data.requestedBy}), attempt ${job.attemptsMade + 1}`);
        const result = await this.reconciliationService.reconcileAllWallets();
        this.logger.log(`Reconcile-all job ${job.id} complete: ${result.walletsChecked} wallets, ` +
            `${result.discrepancies.length} discrepancies`);
        return result;
    }
    onJobFailed(job, error) {
        this.logger.error(`Reconciliation job ${job.id} FAILED (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1}): ${error.message}`, error.stack);
    }
    onJobCompleted(job) {
        this.logger.debug(`Reconciliation job ${job.id} completed`);
    }
};
exports.ReconciliationProcessor = ReconciliationProcessor;
__decorate([
    (0, bull_1.Process)({ name: 'reconcile-all', concurrency: 1 }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ReconciliationProcessor.prototype, "handleReconcileAll", null);
__decorate([
    (0, bull_1.OnQueueFailed)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Error]),
    __metadata("design:returntype", void 0)
], ReconciliationProcessor.prototype, "onJobFailed", null);
__decorate([
    (0, bull_1.OnQueueCompleted)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ReconciliationProcessor.prototype, "onJobCompleted", null);
exports.ReconciliationProcessor = ReconciliationProcessor = ReconciliationProcessor_1 = __decorate([
    (0, common_1.Injectable)(),
    (0, bull_1.Processor)(exports.RECONCILIATION_QUEUE),
    __metadata("design:paramtypes", [reconciliation_service_1.ReconciliationService])
], ReconciliationProcessor);
