import { validateSync } from 'class-validator';
import { BroadcastDto } from '../system/dto/broadcast.dto';
import { UpdateConfigDto } from '../system/dto/update-config.dto';
import { CreateAdminDto } from '../management/dto/create-admin.dto';
import { UpdateAdminDto } from '../management/dto/update-admin.dto';
import { ResolveReportDto } from '../reports/dto/resolve-report.dto';
import { WebhookDeadLetterResolutionDto } from '../system/dto/webhook-dead-letter.dto';

function errors(value: object): string[] {
  return validateSync(value).flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('Admin control-plane DTO boundaries', () => {
  it('rejects empty broadcast content and duplicate channels', () => {
    const dto = Object.assign(new BroadcastDto(), { title: '  ', body: 'ok', channels: ['in_app', 'in_app'] });
    expect(errors(dto)).toEqual(expect.arrayContaining(['matches']));
    expect(validateSync(dto).find((error) => error.property === 'channels')?.constraints).toEqual(expect.objectContaining({ arrayUnique: expect.any(String) }));
  });

  it('accepts in-app and FCM push broadcast channels together', () => {
    const dto = Object.assign(new BroadcastDto(), {
      title: 'Pengumuman Kahade',
      body: 'Pesan untuk pengguna Kahade',
      channels: ['in_app', 'push'],
      targetAudience: 'all',
    });
    expect(errors(dto)).toEqual([]);
  });

  it('rejects whitespace-only config values', () => {
    const dto = Object.assign(new UpdateConfigDto(), { value: '   ' });
    expect(errors(dto)).toContain('matches');
  });

  it('rejects whitespace-only operator names on create and update', () => {
    const create = Object.assign(new CreateAdminDto(), { fullName: '  ', email: 'admin@example.com', password: 'StrongPassword1!', role: 'CUSTOMER_SUPPORT' });
    const update = Object.assign(new UpdateAdminDto(), { fullName: '  ' });
    expect(errors(create)).toContain('matches');
    expect(errors(update)).toContain('matches');
  });

  it('rejects whitespace-only report and webhook resolution notes', () => {
    const report = Object.assign(new ResolveReportDto(), { resolution: '     ', resolveStatus: 'RESOLVED_NO_ACTION' });
    const webhook = Object.assign(new WebhookDeadLetterResolutionDto(), { resolution: '   ' });
    expect(errors(report)).toContain('matches');
    expect(errors(webhook)).toContain('matches');
  });
});
