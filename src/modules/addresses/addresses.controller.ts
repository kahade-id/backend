import { Controller, Get, Post, Patch, Delete, Body, Param, Query, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AddressesService } from './addresses.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';

@ApiTags('addresses')
@ApiBearerAuth('access-token')
@Controller('addresses')
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get()
  @ApiOperation({ summary: 'Daftar alamat milik user (default paling atas)' })
  list(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    return this.addressesService.listAddresses(userId, pagination.page ?? 1, pagination.limit ?? 20) as Promise<
      PaginatedResponse<Record<string, unknown>>
    >;
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post()
  @ApiOperation({ summary: 'Tambah alamat baru (pertama otomatis default)' })
  @ApiResponse({ status: 201 })
  create(@CurrentUser('sub') userId: string, @Body() dto: CreateAddressDto) {
    return this.addressesService.createAddress(userId, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get(':id')
  @ApiOperation({ summary: 'Detail satu alamat' })
  getOne(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.addressesService.getAddress(userId, id);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Patch(':id')
  @ApiOperation({ summary: 'Ubah alamat' })
  update(@CurrentUser('sub') userId: string, @Param('id') id: string, @Body() dto: UpdateAddressDto) {
    return this.addressesService.updateAddress(userId, id, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Hapus alamat (soft delete)' })
  remove(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.addressesService.deleteAddress(userId, id);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post(':id/set-default')
  @HttpCode(200)
  @ApiOperation({ summary: 'Jadikan alamat default' })
  setDefault(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.addressesService.setDefaultAddress(userId, id);
  }
}
