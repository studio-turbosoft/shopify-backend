import { Module } from '@nestjs/common';
import { ProductImportService } from './product-import.service';
import { ProductSyncService } from './product-sync.service';
import { ShopController } from './shop.controller';
import { ShopifyAdminService } from './shopify-admin.service';
import { ShopifyAuthService } from './shopify-auth.service';
import { ShopifySyncController } from './shopify-sync.controller';
import { ShopifyWebhookService } from './shopify-webhook.service';
import { ShopifyWebhooksController } from './shopify-webhooks.controller';

/**
 * Talking to Shopify: access tokens per store (token exchange), Admin GraphQL calls, the product
 * push (app → Shopify), the import and the webhooks (Shopify → app).
 */
@Module({
  controllers: [ShopController, ShopifySyncController, ShopifyWebhooksController],
  providers: [ShopifyAuthService, ShopifyAdminService, ProductSyncService, ProductImportService, ShopifyWebhookService],
  // Products and orders push their changes to Shopify through ProductSyncService.
  exports: [ProductSyncService],
})
export class ShopifyModule {}
