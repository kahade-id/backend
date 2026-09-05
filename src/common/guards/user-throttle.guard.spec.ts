import { ExecutionContext, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { UserThrottleGuard } from './user-throttle.guard';
import { AdminUsersController } from '../../modules/admin/users/admin-users.controller';
import { AdminManagementController } from '../../modules/admin/management/admin-management.controller';
import { AdminSystemController } from '../../modules/admin/system/admin-system.controller';
import { AdminKycController } from '../../modules/admin/kyc/admin-kyc.controller';
import { AdminSubscriptionsController } from '../../modules/admin/subscriptions/admin-subscriptions.controller';
import { AdminVouchersController } from '../../modules/admin/vouchers/admin-vouchers.controller';
import { AdminAuthController } from '../../modules/admin/auth/admin-auth.controller';
import { AdminFinanceController } from '../../modules/admin/finance/admin-finance.controller';

type Handler = (...args: never[]) => unknown;

function handlerOf(controller: object, name: string): Handler {
  const handler = (controller as unknown as Record<string, Handler>)[name];
  if (typeof handler !== 'function') throw new Error(`Missing handler ${name}`);
  return handler;
}

function mutationHandlerNames(controller: object): string[] {
  const proto = controller as object;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .filter((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      const method = descriptor?.value;
      const requestMethod = method && Reflect.getMetadata(METHOD_METADATA, method);
      return typeof method === 'function' && requestMethod !== undefined && requestMethod !== RequestMethod.GET;
    });
}

describe('UserThrottleGuard admin hardening', () => {
  it('tracks an authenticated admin by admin subject instead of IP', async () => {
    const evalSlidingWindow = jest.fn().mockResolvedValue(true);
    const guard = new UserThrottleGuard(
      { evalSlidingWindow } as never,
      { get: jest.fn((key: string) => key === 'app.throttleGlobalTtlMs' ? 60_000 : 100) } as never,
    );
    const request = {
      admin: { sub: 'admin-1' },
      ip: '198.51.100.20',
      socket: { remoteAddress: '198.51.100.20' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(evalSlidingWindow).toHaveBeenCalledWith(
      'throttle:sliding:admin:admin-1',
      60_000,
      100,
      expect.any(Number),
    );
  });

  it('prefers req.admin when the global guard also populated req.user', async () => {
    const evalSlidingWindow = jest.fn().mockResolvedValue(true);
    const guard = new UserThrottleGuard(
      { evalSlidingWindow } as never,
      { get: jest.fn((key: string) => key === 'app.throttleGlobalTtlMs' ? 60_000 : 100) } as never,
    );
    const request = {
      user: { sub: 'admin-1' },
      admin: { sub: 'admin-1' },
      ip: '198.51.100.20',
      socket: { remoteAddress: '198.51.100.20' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(evalSlidingWindow).toHaveBeenCalledWith(
      'throttle:sliding:admin:admin-1',
      60_000,
      100,
      expect.any(Number),
    );
  });

  it('covers sensitive admin mutations outside order/dispute controllers', () => {
    const contracts: Array<[object, string[]]> = [
      [AdminUsersController.prototype, ['adjustWallet', 'resetUserPassword', 'forceLogout', 'revokeUserSession', 'banUser', 'unbanUser']],
      [AdminManagementController.prototype, ['createAdmin', 'updateAdmin', 'resetAdmin2fa', 'unlockAdmin', 'deleteAdmin']],
      [AdminSystemController.prototype, ['updateConfig', 'approveConfigChange', 'rejectConfigChange', 'retryDeadLetterWebhook', 'resolveDeadLetterWebhook', 'sendBroadcast']],
      [AdminKycController.prototype, ['getDocumentUrls', 'approve', 'reject', 'revoke']],
      [AdminSubscriptionsController.prototype, ['forceCancelSubscription']],
      [AdminVouchersController.prototype, ['createVoucher', 'deactivateVoucher']],
      [AdminAuthController.prototype, ['logout']],
      [AdminFinanceController.prototype, ['approveWithdrawal', 'rejectWithdrawal', 'reconcileUser', 'reconcileAll']],
    ];

    for (const [controller, names] of contracts) {
      for (const name of names) {
        const handler = handlerOf(controller, name);
        expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(UserThrottleGuard);
      }
    }
  });
});
