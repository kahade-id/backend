/**
 * ADM-422 — kontrak guard AdminOpsAliasController vs AdminManagementController.
 *
 * AdminOpsAliasController menduplikasi route management untuk kontrak admin web.
 * Duplikasi manual = drift menunggu terjadi (satu sisi diubah, sisi lain lupa).
 * Test ini menegaskan kedua controller membawa tumpukan guard/role/metadata
 * yang IDENTIK di level class — bila ada yang mengubah satu sisi tanpa sisi
 * lain, test ini gagal (fail-closed terhadap drift).
 */
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtAdminGuard } from '../../../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../../../common/guards/admin-roles.guard';
import { ADMIN_ROLES_KEY } from '../../../../common/decorators/admin-roles.decorator';
import { IS_ADMIN_ROUTE_KEY } from '../../../../common/decorators/public.decorator';
import { AdminManagementController } from '../admin-management.controller';
import { AdminOpsAliasController } from '../admin-ops-alias.controller';

const EXPECTED_GUARDS = [JwtAdminGuard, AdminRolesGuard];
const EXPECTED_ROLES = ['SUPER_ADMIN'];

function classGuards(controller: object): unknown[] {
  return Reflect.getMetadata(GUARDS_METADATA, controller) ?? [];
}

function classRoles(controller: object): unknown[] {
  return Reflect.getMetadata(ADMIN_ROLES_KEY, controller) ?? [];
}

describe('ADM-422 — kontrak guard alias vs management controller', () => {
  const controllers = [AdminManagementController, AdminOpsAliasController];

  it.each(controllers)('%p memakai tumpukan guard [JwtAdminGuard, AdminRolesGuard]', (controller) => {
    expect(classGuards(controller)).toEqual(EXPECTED_GUARDS);
  });

  it.each(controllers)('%p terkunci ke SUPER_ADMIN', (controller) => {
    expect(classRoles(controller)).toEqual(EXPECTED_ROLES);
  });

  it.each(controllers)('%p bertanda @AdminRoute() (lapis global JwtAuthGuard)', (controller) => {
    expect(Reflect.getMetadata(IS_ADMIN_ROUTE_KEY, controller)).toBe(true);
  });

  it('reflektor Nest (getAllAndOverride) melihat metadata identik di kedua controller', () => {
    const reflector = new Reflector();
    const guardsA = reflector.getAllAndOverride<unknown[]>(GUARDS_METADATA, [
      AdminManagementController,
    ]);
    const guardsB = reflector.getAllAndOverride<unknown[]>(GUARDS_METADATA, [
      AdminOpsAliasController,
    ]);
    const rolesA = reflector.getAllAndOverride<string[]>(ADMIN_ROLES_KEY, [AdminManagementController]);
    const rolesB = reflector.getAllAndOverride<string[]>(ADMIN_ROLES_KEY, [AdminOpsAliasController]);
    expect(guardsB).toEqual(guardsA);
    expect(rolesB).toEqual(rolesA);
  });
});
