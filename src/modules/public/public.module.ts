import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { OrdersModule } from '../orders/orders.module';
import { ShowcaseModule } from '../showcase/showcase.module';
import { DeepLinksController } from './deep-links.controller';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';

@Module({
  imports: [PrismaModule, UsersModule, OrdersModule, ShowcaseModule],
  controllers: [PublicController, DeepLinksController],
  providers: [PublicService],
  exports: [PublicService],
})
export class PublicModule {}
