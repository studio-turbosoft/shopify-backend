import { Module } from '@nestjs/common';
import { ProductSyncService } from './product-sync.service';
import { ShopController } from './shop.controller';
import { ShopifyAdminService } from './shopify-admin.service';
import { ShopifyAuthService } from './shopify-auth.service';

/** Talking to Shopify: access tokens per store (token exchange), Admin GraphQL calls and the product sync. */
@Module({
  controllers: [ShopController],
  providers: [ShopifyAuthService, ShopifyAdminService, ProductSyncService],
  // Products and orders push their changes to Shopify through ProductSyncService.
  exports: [ShopifyAdminService, ProductSyncService],
})
export class ShopifyModule {}
