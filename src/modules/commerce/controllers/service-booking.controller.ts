import { Controller, Get, Post, Delete, Body, Param, Query, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ServiceBookingService } from '../services/service-booking.service';
import { CreateServiceSlotDto } from '../dto/commerce.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { Public } from '../../../common/decorators/public.decorator';

@ApiTags('commerce-service-slots')
@ApiBearerAuth('access-token')
@Controller('commerce/service-slots')
export class ServiceBookingController {
  constructor(private readonly service: ServiceBookingService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post()
  @ApiOperation({ summary: 'Seller membuat slot ketersediaan (produk JASA)' })
  createSlot(@CurrentUser('sub') sellerId: string, @Body() dto: CreateServiceSlotDto) {
    return this.service.createSlot(sellerId, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 120 } })
  // BFE-116: didokumentasikan publik — slot jasa terlihat anonim.
  @Public()
  @Get('showcase/:showcaseId')
  @ApiOperation({ summary: 'Daftar slot tersedia per produk (publik)' })
  listSlots(
    @Param('showcaseId') showcaseId: string,
    @Query('from') from: string | undefined,
    @Query() pagination: PaginationDto,
  ) {
    return this.service.listSlots(showcaseId, from, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Seller menonaktifkan slot' })
  deleteSlot(@CurrentUser('sub') sellerId: string, @Param('id') id: string) {
    return this.service.deleteSlot(sellerId, id);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post(':id/book')
  @HttpCode(200)
  @ApiOperation({ summary: 'Buyer booking slot' })
  bookSlot(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.service.bookSlot(userId, id);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('bookings/mine')
  @ApiOperation({ summary: 'Booking milik user' })
  myBookings(@CurrentUser('sub') userId: string, @Query() pagination: PaginationDto) {
    return this.service.myBookings(userId, pagination.page ?? 1, pagination.limit ?? 20);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('bookings/:bookingId/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Batalkan booking milik sendiri' })
  cancelBooking(@CurrentUser('sub') userId: string, @Param('bookingId') bookingId: string) {
    return this.service.cancelBooking(userId, bookingId);
  }
}
