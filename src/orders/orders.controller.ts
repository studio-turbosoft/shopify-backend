import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { OptionalSession } from '../auth/optional-session.decorator';
import { ShopifySessionGuard, type ShopifySession } from '../auth/shopify-session.guard';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';

// Only callable from the app inside the Shopify admin (valid session token).
// Stock changes are pushed to that store; with SHOPIFY_AUTH=off and no token they stay local.
@UseGuards(ShopifySessionGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  findAll() {
    return this.orders.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.orders.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateOrderDto, @OptionalSession() session?: ShopifySession) {
    return this.orders.create(dto, session);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOrderDto,
    @OptionalSession() session?: ShopifySession,
  ) {
    return this.orders.update(id, dto, session);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseIntPipe) id: number, @OptionalSession() session?: ShopifySession) {
    return this.orders.remove(id, session);
  }
}
