import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto';
import { toIdr } from '../../common/utils/currency.util';

const MAX_TEMPLATES_PER_USER = 20;

@Injectable()
export class TransactionTemplatesService {
  constructor(private prisma: PrismaService) {}

  async getMyTemplates(userId: string) {
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
        orderValue: toIdr(t.orderValue),
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

  async getTemplate(userId: string, templateId: string) {
    const template = await this.prisma.transactionTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' });
    if (template.userId !== userId) throw new ForbiddenException({ code: 'TEMPLATE_NOT_OWNED', message: 'Not your template' });

    return {
      id: template.id,
      name: template.name,
      title: template.title,
      description: template.description,
      orderType: template.orderType,
      orderValue: toIdr(template.orderValue),
      feeResponsibility: template.feeResponsibility,
      deliveryDeadlineDays: template.deliveryDeadlineDays,
      isDefault: template.isDefault,
      usageCount: template.usageCount,
      lastUsedAt: template.lastUsedAt,
      createdAt: template.createdAt,
    };
  }

  async createTemplate(userId: string, dto: CreateTemplateDto) {
    const count = await this.prisma.transactionTemplate.count({ where: { userId } });
    if (count >= MAX_TEMPLATES_PER_USER) {
      throw new BadRequestException({ code: 'TEMPLATE_LIMIT_REACHED', message: `Maximum ${MAX_TEMPLATES_PER_USER} templates allowed` });
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

  async updateTemplate(userId: string, templateId: string, dto: UpdateTemplateDto) {
    const template = await this.prisma.transactionTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' });
    if (template.userId !== userId) throw new ForbiddenException({ code: 'TEMPLATE_NOT_OWNED', message: 'Not your template' });

    const updateData: Record<string, unknown> = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.orderType !== undefined) updateData.orderType = dto.orderType;
    if (dto.orderValue !== undefined) updateData.orderValue = BigInt(Math.round(dto.orderValue * 100));
    if (dto.feeResponsibility !== undefined) updateData.feeResponsibility = dto.feeResponsibility;
    if (dto.deliveryDeadlineDays !== undefined) updateData.deliveryDeadlineDays = dto.deliveryDeadlineDays;
    if (dto.isDefault !== undefined) updateData.isDefault = dto.isDefault;

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

  async deleteTemplate(userId: string, templateId: string) {
    const template = await this.prisma.transactionTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Template not found' });
    if (template.userId !== userId) throw new ForbiddenException({ code: 'TEMPLATE_NOT_OWNED', message: 'Not your template' });

    await this.prisma.transactionTemplate.delete({ where: { id: templateId } });
    return { message: 'Template deleted successfully' };
  }

  async recordUsage(templateId: string) {
    await this.prisma.transactionTemplate.update({
      where: { id: templateId },
      data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
    });
  }
}
