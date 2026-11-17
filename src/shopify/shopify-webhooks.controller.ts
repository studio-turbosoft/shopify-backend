import { Controller, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { isShopDomain, ShopifyWebhookService } from './shopify-webhook.service';

/**
 * POST /api/webhooks/shopify: every webhook topic of the app goes here (one URL in the Dev Dashboard).
 * https://shopify.dev/docs/apps/build/webhooks/subscribe/https
 *
 * No session guard: Shopify signs the raw body with the app's client secret instead
 * (X-Shopify-Hmac-Sha256). Needs NestFactory.create(..., { rawBody: true }) in main.ts.
 * Shopify expects a 2xx within 5 seconds, so we answer right after verification and process later.
 */
@Controller('webhooks/shopify')
export class ShopifyWebhooksController {
  private readonly logger = new Logger(ShopifyWebhooksController.name);

  constructor(private readonly webhooks: ShopifyWebhookService) {}

  @Post()
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>): void {
    if (!this.webhooks.verify(req.rawBody, req.get('x-shopify-hmac-sha256'))) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const topic = req.get('x-shopify-topic') ?? '';
    const shop = req.get('x-shopify-shop-domain')?.toLowerCase();
    if (!topic || !isShopDomain(shop)) {
      // Signed by Shopify but unusable: acknowledge so it isn't retried.
      this.logger.warn(`Webhook without a valid topic / shop domain ignored (topic "${topic}", shop "${shop ?? ''}")`);
      return;
    }

    this.webhooks.accept({
      topic,
      shop,
      webhookId: req.get('x-shopify-webhook-id') ?? null,
      payload: req.body,
      raw: req.rawBody!.toString('utf8'),
    });
  }
}
