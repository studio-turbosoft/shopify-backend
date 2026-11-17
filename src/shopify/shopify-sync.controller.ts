import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentSession } from '../auth/current-session.decorator';
import { ShopifySessionGuard, type ShopifySession } from '../auth/shopify-session.guard';
import { ProductImportService } from './product-import.service';

// POST /api/shopify/sync: import the store's products (Shopify → our database).
// Needs a real session: the store comes from the session token.
@UseGuards(ShopifySessionGuard)
@Controller('shopify')
export class ShopifySyncController {
  constructor(private readonly importer: ProductImportService) {}

  @Post('sync')
  @HttpCode(200)
  sync(@CurrentSession() session: ShopifySession) {
    return this.importer.importAll(session);
  }
}
