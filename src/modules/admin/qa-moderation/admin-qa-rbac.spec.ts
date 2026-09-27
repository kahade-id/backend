/**
 * GAP-F (G447/G449): RBAC moderasi Q&A — matriks role & penolakan non-admin.
 *
 * - Metadata @AdminRoles pada controller & method (otoritas RBAC).
 * - AdminRolesGuard: fail-closed tanpa role; 403 untuk role yang tidak
 *   diizinkan; CUSTOMER_SUPPORT boleh hide/unhide tapi bukan export/delete.
 * - JwtAdminGuard: token user biasa (aud 'kahade-api', bukan
 *   'kahade-admin-api') DITOLAK dengan 401 — endpoint admin tidak bisa
 *   dipakai pemilik profil (G428).
 */
import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '@prisma/client';
import { ADMIN_ROLES_KEY } from '../../../common/decorators/admin-roles.decorator';
import { AdminRolesGuard } from '../../../common/guards/admin-roles.guard';
import { JwtAdminGuard } from '../../../common/guards/jwt-admin.guard';
import { AdminQaModerationController } from './admin-qa-moderation.controller';

function classRoles(): AdminRole[] {
  return Reflect.getMetadata(ADMIN_ROLES_KEY, AdminQaModerationController);
}

function methodRoles(method: keyof AdminQaModerationController): AdminRole[] | undefined {
  // NestJS SetMetadata pada method menyimpan metadata di descriptor.value
  // (fungsi method itu sendiri), bukan via Reflect 3-arg pada prototype.
  const handler = (AdminQaModerationController.prototype as unknown as Record<string, (...args: never[]) => unknown>)[method as string];
  return Reflect.getMetadata(ADMIN_ROLES_KEY, handler);
}

function makeCtx(admin?: { role: string }): ExecutionContext {
  return {
    getHandler: () => jest.fn(),
    getClass: () => AdminQaModerationController,
    switchToHttp: () => ({ getRequest: () => ({ admin }) }),
  } as unknown as ExecutionContext;
}

function guardWithRoles(handlerRoles: AdminRole[] | undefined, classRolesVal: AdminRole[] = classRoles()): AdminRolesGuard {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(handlerRoles ?? classRolesVal),
  } as unknown as Reflector;
  return new AdminRolesGuard(reflector);
}

describe('AdminQaModerationController RBAC (G447/G449)', () => {
  describe('metadata @AdminRoles', () => {
    it('class-level: SUPER_ADMIN + CUSTOMER_SUPPORT (tanpa role moderator khusus)', () => {
      expect(classRoles()).toEqual(expect.arrayContaining([AdminRole.SUPER_ADMIN, AdminRole.CUSTOMER_SUPPORT]));
      expect(classRoles()).toHaveLength(2);
    });

    it('ekspor audit agregat: hanya SUPER_ADMIN', () => {
      expect(methodRoles('exportCsv')).toEqual([AdminRole.SUPER_ADMIN]);
    });

    it('hapus permanen (request/approve/reject + list): hanya SUPER_ADMIN', () => {
      for (const m of [
        'listDeleteRequests',
        'requestDeleteQuestion',
        'requestDeleteComment',
        'approveDeleteRequest',
        'rejectDeleteRequest',
      ] as const) {
        expect(methodRoles(m)).toEqual([AdminRole.SUPER_ADMIN]);
      }
    });

    it('queue/hide/unhide/redact/bulk/appeal: mewarisi class-level (CS boleh)', () => {
      for (const m of [
        'getQueue',
        'hideQuestion',
        'unhideQuestion',
        'hideComment',
        'unhideComment',
        'redact',
        'bulkHide',
        'bulkUnhide',
        'assignReport',
        'resolveReport',
        'listAppeals',
        'reviewAppeal',
        'getQuestionDetail',
        'getCommentDetail',
        'getMetrics',
        'getSpamCandidates',
      ] as const) {
        expect(methodRoles(m)).toBeUndefined();
      }
    });
  });

  describe('AdminRolesGuard', () => {
    it('fail-closed: 403 bila tidak ada role terkonfigurasi', () => {
      const guard = guardWithRoles(undefined, []);
      expect(() => guard.canActivate(makeCtx({ role: 'SUPER_ADMIN' }))).toThrow(ForbiddenException);
    });

    it('403 bila request tanpa admin (belum terautentikasi)', () => {
      const guard = guardWithRoles(undefined);
      expect(() => guard.canActivate(makeCtx(undefined))).toThrow(ForbiddenException);
    });

    it('403 untuk DISPUTE_ADMIN di endpoint QA (bukan role moderasi Q&A)', () => {
      const guard = guardWithRoles(undefined);
      expect(() => guard.canActivate(makeCtx({ role: 'DISPUTE_ADMIN' }))).toThrow(ForbiddenException);
    });

    it('CUSTOMER_SUPPORT boleh hide/unhide (class-level)', () => {
      const guard = guardWithRoles(undefined);
      expect(guard.canActivate(makeCtx({ role: 'CUSTOMER_SUPPORT' }))).toBe(true);
    });

    it('CUSTOMER_SUPPORT DITOLAK untuk export & delete permanen (method SUPER_ADMIN)', () => {
      const exportGuard = guardWithRoles([AdminRole.SUPER_ADMIN]);
      expect(() => exportGuard.canActivate(makeCtx({ role: 'CUSTOMER_SUPPORT' }))).toThrow(
        ForbiddenException,
      );
    });

    it('SUPER_ADMIN boleh semua', () => {
      const guard = guardWithRoles(undefined);
      expect(guard.canActivate(makeCtx({ role: 'SUPER_ADMIN' }))).toBe(true);
      const exportGuard = guardWithRoles([AdminRole.SUPER_ADMIN]);
      expect(exportGuard.canActivate(makeCtx({ role: 'SUPER_ADMIN' }))).toBe(true);
    });
  });

  describe('JwtAdminGuard — token user biasa ditolak', () => {
    function makeGuard(verifyImpl: () => Promise<never>) {
      const jwtService = { verifyAsync: jest.fn().mockImplementation(verifyImpl) };
      const redisService = { get: jest.fn() };
      const configService = { get: jest.fn().mockReturnValue('secret') };
      return new JwtAdminGuard(
        jwtService as never,
        redisService as never,
        configService as never,
        {} as never,
      );
    }

    function userTokenCtx(): ExecutionContext {
      return {
        switchToHttp: () => ({
          getRequest: () => ({ headers: { authorization: 'Bearer user-access-token' } }),
        }),
      } as unknown as ExecutionContext;
    }

    it('token dengan aud salah (user token) → 401 Unauthorized', async () => {
      const guard = makeGuard(() => {
        const err = new Error('jwt audience invalid. expected: kahade-admin-api');
        err.name = 'JsonWebTokenError';
        throw err;
      });
      await expect(guard.canActivate(userTokenCtx())).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('tanpa token → 401', async () => {
      const guard = makeGuard(() => {
        throw new Error('unreachable');
      });
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
