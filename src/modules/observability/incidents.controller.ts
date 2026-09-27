/**
 * Kahade — kelola insiden untuk halaman status publik (G497).
 *
 * SUPER_ADMIN saja: membuat/mengubah/menutup insiden yang tampil di
 * `GET /v1/status` dan (nanti) halaman status publik web.
 * Deskripsi ditulis untuk PUBLIK — validator menolak pola yang tampak
 * seperti PII (nomor HP, email, NIK 16 digit) agar tidak bocor ke publik.
 */
import {
  BadRequestException,
  Body, Controller, Get, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminRoute } from '../../common/decorators/public.decorator';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

const SUPER = 'SUPER_ADMIN' as const;
const ALL_ROLES = ['SUPER_ADMIN', 'DISPUTE_ADMIN', 'KYC_ADMIN', 'FINANCE_ADMIN', 'CUSTOMER_SUPPORT'] as const;

const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
const STATUSES = ['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'] as const;

/** Pola kasar PII — deskripsi insiden publik tidak boleh mengandungnya. */
const PII_PATTERNS = [
  /(\+62|62|0)8\d{8,12}/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /\b\d{16}\b/,
];

function assertNoPii(text: string, field: string): void {
  for (const re of PII_PATTERNS) {
    if (re.test(text)) {
      throw new BadRequestException({ code: 'INCIDENT_PII_DETECTED', message: `${field} terdeteksi mengandung data pribadi — tulis ulang tanpa nomor HP/email/NIK` });
    }
  }
}

type IncidentRow = {
  create: (args: unknown) => Promise<unknown>;
  update: (args: unknown) => Promise<unknown>;
  findMany: (args: unknown) => Promise<unknown[]>;
};

@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoute() // ADM-411: lapis kedua — global JwtAuthGuard ikut mewajibkan token admin.
@Controller('admin/observability/incidents')
@Throttle({ default: { ttl: 60_000, limit: 30 } })
export class IncidentsController {
  constructor(private readonly prisma: PrismaService) {}

  private get model(): IncidentRow {
    return (this.prisma as unknown as { incidentLog: IncidentRow }).incidentLog;
  }

  /** Daftar insiden — semua role admin boleh membaca. */
  @Get()
  @AdminRoles(...ALL_ROLES)
  async list(@Query('status') status?: string) {
    return {
      incidents: await this.model.findMany({
        where: status ? { status } : undefined,
        orderBy: { startedAt: 'desc' },
        take: 100,
      }),
    };
  }

  @Post()
  @AdminRoles(SUPER)
  async create(
    @Body() body: { title: string; description: string; severity: string; component: string },
  ) {
    if (!body.title?.trim() || !body.description?.trim())
      // ADM-303: fail-closed 400 dengan kode, bukan Error mentah (→ 500).
      throw new BadRequestException({ code: 'INCIDENT_TITLE_DESCRIPTION_REQUIRED', message: 'title & description wajib diisi' });
    if (!(SEVERITIES as readonly string[]).includes(body.severity))
      throw new BadRequestException({ code: 'INCIDENT_SEVERITY_INVALID', message: 'severity tidak valid' });
    assertNoPii(body.title, 'title');
    assertNoPii(body.description, 'description');
    return this.model.create({
      data: {
        title: body.title.trim().slice(0, 200),
        description: body.description.trim(),
        severity: body.severity,
        component: String(body.component || 'api').slice(0, 100),
        status: 'INVESTIGATING',
      },
    });
  }

  @Patch(':id')
  @AdminRoles(SUPER)
  async update(
    @Param('id') id: string,
    @Body() body: { title?: string; description?: string; severity?: string; status?: string; component?: string },
  ) {
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) {
      assertNoPii(body.title, 'title');
      data.title = body.title.trim().slice(0, 200);
    }
    if (body.description !== undefined) {
      assertNoPii(body.description, 'description');
      data.description = body.description.trim();
    }
    if (body.severity !== undefined) {
      // ADM-303: fail-closed 400, bukan Error mentah (→ 500).
      if (!(SEVERITIES as readonly string[]).includes(body.severity))
        throw new BadRequestException({ code: 'INCIDENT_SEVERITY_INVALID', message: 'severity tidak valid' });
      data.severity = body.severity;
    }
    if (body.status !== undefined) {
      if (!(STATUSES as readonly string[]).includes(body.status))
        throw new BadRequestException({ code: 'INCIDENT_STATUS_INVALID', message: 'status tidak valid' });
      data.status = body.status;
      if (body.status === 'RESOLVED') data.resolvedAt = new Date();
    }
    if (body.component !== undefined) data.component = String(body.component).slice(0, 100);
    return this.model.update({ where: { id }, data });
  }
}
