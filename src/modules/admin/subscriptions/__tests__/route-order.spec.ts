import 'reflect-metadata';
import { AdminSubscriptionsController } from '../admin-subscriptions.controller';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

describe('AdminSubscriptionsController route order', () => {
  it('registers @Get(promo-codes) before @Get(:subId)', () => {
    const proto: any = AdminSubscriptionsController.prototype;
    const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor');
    const getRoutes: { name: string; path: string }[] = [];
    for (const m of methods) {
      const path = Reflect.getMetadata(PATH_METADATA, proto[m]);
      const method = Reflect.getMetadata(METHOD_METADATA, proto[m]);
      if (path !== undefined && method === RequestMethod.GET) {
        getRoutes.push({ name: m, path: String(path) });
      }
    }
    const promoIdx = getRoutes.findIndex((r) => r.path === 'promo-codes');
    const subIdIdx = getRoutes.findIndex((r) => r.path === ':subId');
    expect(promoIdx).toBeGreaterThanOrEqual(0);
    expect(subIdIdx).toBeGreaterThanOrEqual(0);
    expect(promoIdx).toBeLessThan(subIdIdx);
  });
});
