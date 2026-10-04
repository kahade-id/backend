import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminSupportChatController } from '../admin-support-chat.controller';
import { JwtAdminGuard } from '../../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../../common/guards/admin-roles.guard';
import { ADMIN_ROLES_KEY } from '../../../../common/decorators/admin-roles.decorator';
import { AdminRole } from '@prisma/client';

// POIN 5 (2026-10-04): endpoint livechat admin harus terkunci untuk peran
// support — tidak ada jalur admin di luar CUSTOMER_SUPPORT/SUPER_ADMIN.
describe('AdminSupportChatController — guards & roles', () => {
  it('controller memakai JwtAdminGuard + AdminRolesGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminSupportChatController) as unknown[];
    expect(guards).toContain(JwtAdminGuard);
    expect(guards).toContain(AdminRolesGuard);
  });

  it('hanya SUPER_ADMIN dan CUSTOMER_SUPPORT yang boleh akses', () => {
    const roles = Reflect.getMetadata(ADMIN_ROLES_KEY, AdminSupportChatController) as AdminRole[];
    expect(roles).toContain(AdminRole.SUPER_ADMIN);
    expect(roles).toContain(AdminRole.CUSTOMER_SUPPORT);
    expect(roles).not.toContain(AdminRole.FINANCE_ADMIN);
    expect(roles).not.toContain(AdminRole.KYC_ADMIN);
    expect(roles).not.toContain(AdminRole.DISPUTE_ADMIN);
  });

  it('mengekspos endpoint antrean, claim, close, escalate, agents', () => {
    const proto = AdminSupportChatController.prototype as unknown as Record<string, unknown>;
    for (const m of ['getQueue', 'getDetail', 'getMessages', 'claim', 'close', 'escalate', 'agents', 'availability']) {
      expect(typeof proto[m]).toBe('function');
    }
  });
});
