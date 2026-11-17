import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { OptionalSession } from '../auth/optional-session.decorator';
import { ShopifySessionGuard, type ShopifySession } from '../auth/shopify-session.guard';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

// Only callable from the app inside the Shopify admin (valid session token).
// Writes are pushed to that store; with SHOPIFY_AUTH=off and no token they stay local.
@UseGuards(ShopifySessionGuard)
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  findAll() {
    return this.products.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.products.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateProductDto, @OptionalSession() session?: ShopifySession) {
    return this.products.create(dto, session);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto,
    @OptionalSession() session?: ShopifySession,
  ) {
    return this.products.update(id, dto, session);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseIntPipe) id: number, @OptionalSession() session?: ShopifySession) {
    return this.products.remove(id, session);
  }
}
