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
exports.TransactionTemplatesService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const currency_util_1 = require("../../common/utils/currency.util");
const MAX_TEMPLATES_PER_USER = 20;
let TransactionTemplatesService = class TransactionTemplatesService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getMyTemplates(userId) {
        const templates = await this.prisma.transactionTemplate.findMany({
            where: { userId },
            orderBy: [{ isDefault: 'desc' }, { lastUsedAt: 'desc' }, { createdAt: 'desc' }],
        });
        return {
            templates: templates.map((t) => ({
                id: t.id,
                name: t.name,
                title: t.title,
                description: t.description,
                orderType: t.orderType,
                orderValue: (0, currency_util_1.toIdr)(t.orderValue),
                feeResponsibility: t.feeResponsibility,
                deliveryDeadlineDays: t.deliveryDeadlineDays,
                isDefault: t.isDefault,
                usageCount: t.usageCount,
                lastUsedAt: t.lastUsedAt,
                createdAt: t.createdAt,
            })),
            total: templates.length,
        };
    }
    async getTemplate(userId, templateId) {
        const template = await this.prisma.transactionTemplate.findUnique({
            where: { id: templateId },
        });
        if (!template)
            throw new common_1.NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' });
        if (template.userId !== userId)
            throw new common_1.ForbiddenException({ code: 'TEMPLATE_NOT_OWNED', message: 'Not your template' });
        return {
            id: template.id,
            name: template.name,
            title: template.title,
            description: template.description,
            orderType: template.orderType,
            orderValue: (0, currency_util_1.toIdr)(template.orderValue),
            feeResponsibility: template.feeResponsibility,
            deliveryDeadlineDays: template.deliveryDeadlineDays,
            isDefault: template.isDefault,
            usageCount: template.usageCount,
            lastUsedAt: template.lastUsedAt,
            createdAt: template.createdAt,
        };
    }
    async createTemplate(userId, dto) {
        const count = await this.prisma.transactionTemplate.count({ where: { userId } });
        if (count >= MAX_TEMPLATES_PER_USER) {
            throw new common_1.BadRequestException({ code: 'TEMPLATE_LIMIT_REACHED', message: `Maximum ${MAX_TEMPLATES_PER_USER} templates allowed` });
        }
        const orderValueSen = BigInt(Math.round(dto.orderValue * 100));
        const result = await this.prisma.$transaction(async (tx) => {
            const template = await tx.transactionTemplate.create({
                data: {
                    userId,
                    name: dto.name,
                    title: dto.title,
                    description: dto.description,
                    orderType: dto.orderType,
                    orderValue: orderValueSen,
                    feeResponsibility: dto.feeResponsibility || 'BUYER',
                    deliveryDeadlineDays: dto.deliveryDeadlineDays || 3,
                    isDefault: dto.isDefault || false,
                },
            });
            if (dto.isDefault) {
                await tx.transactionTemplate.updateMany({
                    where: { userId, id: { not: template.id } },
                    data: { isDefault: false },
                });
            }
            return template;
        });
        return {
            id: result.id,
            name: result.name,
            message: 'Template created successfully',
        };
    }
    async updateTemplate(userId, templateId, dto) {
        const template = await this.prisma.transactionTemplate.findUnique({
            where: { id: templateId },
        });
        if (!template)
            throw new common_1.NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' });
        if (template.userId !== userId)
            throw new common_1.ForbiddenException({ code: 'TEMPLATE_NOT_OWNED', message: 'Not your template' });
        const updateData = {};
        if (dto.name !== undefined)
            updateData.name = dto.name;
        if (dto.title !== undefined)
            updateData.title = dto.title;
        if (dto.description !== undefined)
            updateData.description = dto.description;
        if (dto.orderType !== undefined)
            updateData.orderType = dto.orderType;
        if (dto.orderValue !== undefined)
            updateData.orderValue = BigInt(Math.round(dto.orderValue * 100));
        if (dto.feeResponsibility !== undefined)
            updateData.feeResponsibility = dto.feeResponsibility;
        if (dto.deliveryDeadlineDays !== undefined)
            updateData.deliveryDeadlineDays = dto.deliveryDeadlineDays;
        if (dto.isDefault !== undefined)
            updateData.isDefault = dto.isDefault;
        await this.prisma.$transaction(async (tx) => {
            await tx.transactionTemplate.update({
                where: { id: templateId },
                data: updateData,
            });
            if (dto.isDefault) {
                await tx.transactionTemplate.updateMany({
                    where: { userId, id: { not: templateId } },
                    data: { isDefault: false },
                });
            }
        });
        return { message: 'Template updated successfully' };
    }
    async deleteTemplate(userId, templateId) {
        const template = await this.prisma.transactionTemplate.findUnique({
            where: { id: templateId },
        });
        if (!template)
            throw new common_1.NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' });
        if (template.userId !== userId)
            throw new common_1.ForbiddenException({ code: 'TEMPLATE_NOT_OWNED', message: 'Not your template' });
        await this.prisma.transactionTemplate.delete({ where: { id: templateId } });
        return { message: 'Template deleted successfully' };
    }
    async recordUsage(templateId) {
        await this.prisma.transactionTemplate.update({
            where: { id: templateId },
            data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
        });
    }
};
exports.TransactionTemplatesService = TransactionTemplatesService;
exports.TransactionTemplatesService = TransactionTemplatesService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], TransactionTemplatesService);
