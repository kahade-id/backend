import { Controller, Get, Post, Body, Param, Query, HttpCode, GoneException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JastipService } from '../services/jastip.service';
import {
  CreateJastipTripDto,
  AddJastipItemDto,
  JoinJastipDto,
  LockJastipPriceDto,
  LinkJastipOrderDto,
} from '../dto/commerce.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

@ApiTags('jastip')
@ApiBearerAuth('access-token')
@Controller('jastip')
export class JastipController {
  constructor(private readonly service: JastipService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('trips')
  @ApiOperation({ summary: 'Host membuat trip jastip (DRAFT)' })
  createTrip(@CurrentUser('sub') hostId: string, @Body() dto: CreateJastipTripDto) {
    return this.service.createTrip(hostId, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('trips/mine')
  @ApiOperation({ summary: 'Trip milik host' })
  myTrips(@CurrentUser('sub') hostId: string, @Query() pagination: PaginationDto) {
    return this.service.listMyTrips(hostId, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('trips/:id')
  @ApiOperation({ summary: 'Detail trip + katalog + peserta' })
  getTrip(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.service.getTripDetail(userId, id);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('trips/:id/open')
  @HttpCode(200)
  @ApiOperation({ summary: 'Host membuka trip (DRAFT → OPEN)' })
  openTrip(@CurrentUser('sub') hostId: string, @Param('id') id: string) {
    return this.service.openTrip(hostId, id);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('trips/:id/items')
  @ApiOperation({ summary: 'Host menambah item katalog' })
  addItem(@CurrentUser('sub') hostId: string, @Param('id') id: string, @Body() dto: AddJastipItemDto) {
    return this.service.addItem(hostId, id, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('trips/:id/join')
  @ApiOperation({ summary: 'Buyer join trip' })
  joinTrip(@CurrentUser('sub') buyerId: string, @Param('id') id: string, @Body() dto: JoinJastipDto) {
    return this.service.joinTrip(buyerId, id, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('participants/:participantId/lock-price')
  @HttpCode(200)
  @ApiOperation({ summary: 'Host mengunci harga (barang + fee + ongkir terpisah)' })
  lockPrice(
    @CurrentUser('sub') hostId: string,
    @Param('participantId') participantId: string,
    @Body() dto: LockJastipPriceDto,
  ) {
    return this.service.lockPrice(hostId, participantId, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('participants/:participantId/link-order')
  @HttpCode(200)
  @ApiOperation({ summary: 'DINONAKTIFKAN: gunakan POST /v1/jastip/participants/:id/create-order', deprecated: true })
  linkOrder(
    @CurrentUser('sub') buyerId: string,
    @Param('participantId') participantId: string,
    @Body() dto: LinkJastipOrderDto,
  ) {
    throw new GoneException('Endpoint link-order dinonaktifkan. Gunakan POST /v1/jastip/participants/:id/create-order untuk membuat order otomatis.');
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('participants/:participantId/create-order')
  @HttpCode(200)
  @ApiOperation({ summary: 'Buyer membuat escrow order dari peserta (PREORDER+SINGLE+FISIK, orderId terisi otomatis)' })
  createOrder(@CurrentUser('sub') buyerId: string, @Param('participantId') participantId: string) {
    return this.service.createOrderFromParticipant(buyerId, participantId);
  }

  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post('trips/:id/fail')
  @HttpCode(200)
  @ApiOperation({ summary: 'Host gagal dapat barang → trip dibatalkan + refund otomatis' })
  failTrip(
    @CurrentUser('sub') hostId: string,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.service.failTrip(hostId, id, body?.reason);
  }
}
