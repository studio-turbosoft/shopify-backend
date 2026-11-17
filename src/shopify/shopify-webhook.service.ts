import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TtlMap } from '../common/ttl-map';
import { FK_VIOLATION, isPrismaError } from '../common/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { ProductImportService } from './product-import.service';
import { ProductSyncService } from './product-sync.service';
import { ShopNotConnectedError } from './shopify-admin.service';

/**
 * Topics handled (subscribe to them in the app version in the Dev Dashboard, API version 2026-10):
 * https://shopify.dev/docs/api/webhooks/2026-10 (scopes: WebhookSubscriptionTopic enum,
 * https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic)
 *   products/create, products/update, products/delete  (need read_products)
 *   inventory_levels/update                            (needs read_inventory)
 *   app/uninstalled                                    (no scope)
 * Compliance topics (required for App Store apps only) are acknowledged and ignored:
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 */
export const COMPLIANCE_TOPICS = new Set(['customers/data_request', 'customers/redact', 'shop/redact']);

/** A verified delivery. */
export interface WebhookDelivery {
  topic: string;
  shop: string;
  webhookId: string | null;
  /** Parsed JSON body. */
  payload: any;
  /** Raw body text: big numeric ids are read from it so they don't lose precision in JSON.parse. */
  raw: string;
}

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
/** Shopify retries a failed delivery for up to 4 hours; remember ids a bit longer. */
const DEDUPE_TTL_MS = 6 * 60 * 60_000;

export const isShopDomain = (s: string | undefined | null): s is string => !!s && SHOP_DOMAIN.test(s);

/**
 * Digits of a top-level numeric field, read from the raw JSON (ids can exceed 2^53).
 * Falls back to the parsed value.
 */
export function numericIdFromRaw(raw: string, key: string, parsed: unknown): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"?(\\d+)`).exec(raw);
  if (m) return m[1];
  return typeof parsed === 'number' || (typeof parsed === 'string' && /^\d+$/.test(parsed)) ? String(parsed) : null;
}

/** HTTPS webhook HMAC: base64(HMAC-SHA256(raw body, client secret)), compared in constant time. */
export function verifyWebhookHmac(raw: Buffer | undefined, header: string | undefined, secret: string | undefined): boolean {
  if (!secret || !raw || !header) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(header, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Shopify → our database, from webhooks. Deliveries are acknowledged first and processed
 * afterwards; errors are logged, never thrown. Nothing here writes to Shopify.
 */
@Injectable()
export class ShopifyWebhookService {
  private readonly logger = new Logger(ShopifyWebhookService.name);
  /** X-Shopify-Webhook-Id of recent deliveries (in memory: one server instance only). */
  private readonly seen = new TtlMap<string, true>(DEDUPE_TTL_MS, 50_000);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly importer: ProductImportService,
    private readonly sync: ProductSyncService,
  ) {}

  verify(raw: Buffer | undefined, hmacHeader: string | undefined): boolean {
    return verifyWebhookHmac(raw, hmacHeader, this.config.get<string>('SHOPIFY_API_SECRET'));
  }

  /** Queue a verified delivery for processing (after the response). Duplicates are dropped. */
  accept(delivery: WebhookDelivery): void {
    if (delivery.webhookId) {
      if (this.seen.has(delivery.webhookId)) {
        this.logger.log(`Duplicate webhook ${delivery.webhookId} (${delivery.topic}) ignored`);
        return;
      }
      this.seen.set(delivery.webhookId, true);
    }
    setImmediate(() => {
      this.process(delivery).catch((e) =>
        this.logger.error(`Webhook ${delivery.topic} from ${delivery.shop} failed: ${(e as Error).message}`),
      );
    });
  }

  /** Handle one delivery. Exposed for tests; normally called through accept(). */
  async process(d: WebhookDelivery): Promise<void> {
    if (COMPLIANCE_TOPICS.has(d.topic)) {
      // We keep no customer data from Shopify, so there is nothing to export or erase.
      this.logger.log(`Compliance webhook ${d.topic} from ${d.shop} acknowledged (no Shopify customer data stored)`);
      return;
    }
    if (d.topic === 'app/uninstalled') return this.uninstalled(d.shop);

    const handlers: Record<string, (d: WebhookDelivery) => Promise<void>> = {
      'products/create': (x) => this.productChanged(x),
      'products/update': (x) => this.productChanged(x),
      'products/delete': (x) => this.productDeleted(x),
      'inventory_levels/update': (x) => this.inventoryLevelUpdated(x),
    };
    const handler = handlers[d.topic];
    if (!handler) {
      this.logger.log(`Webhook topic ${d.topic} from ${d.shop} ignored`);
      return;
    }
    // Only stores that opened the app (and so have a saved token) are synced.
    if (!(await this.prisma.shop.count({ where: { domain: d.shop } }))) {
      this.logger.warn(`Webhook ${d.topic} from ${d.shop} skipped: no saved access token (open the app in the store once)`);
      return;
    }
    try {
      await handler(d);
    } catch (e) {
      if (e instanceof ShopNotConnectedError) this.logger.warn(`Webhook ${d.topic} skipped: ${e.message}`);
      else throw e;
    }
  }

  /** products/create, products/update: re-read the product from Shopify and upsert it. */
  private async productChanged(d: WebhookDelivery) {
    const numeric = numericIdFromRaw(d.raw, 'id', d.payload?.id);
    const gid =
      typeof d.payload?.admin_graphql_api_id === 'string' && /^gid:\/\/shopify\/Product\/\d+$/.test(d.payload.admin_graphql_api_id)
        ? (d.payload.admin_graphql_api_id as string)
        : numeric && `gid://shopify/Product/${numeric}`;
    if (!gid) {
      this.logger.warn(`${d.topic}: payload has no product id`);
      return;
    }

    // Loop guard: Shopify's updated_at up to the updatedAt we stored after our own productSet
    // means this event is our change coming back.
    const updatedAt = new Date(d.payload?.updated_at);
    const pushed = this.sync.recentProductPush(gid);
    const local = await this.prisma.product.findUnique({
      where: { shopifyProductId: gid },
      select: { id: true, shopifySyncedAt: true },
    });
    if (!Number.isNaN(updatedAt.getTime())) {
      const ownChange =
        (pushed && updatedAt.getTime() <= pushed.getTime()) ||
        (local?.shopifySyncedAt && updatedAt.getTime() <= local.shopifySyncedAt.getTime());
      if (ownChange) {
        this.logger.log(`${d.topic} ${gid} ignored: our own change (updated_at ${d.payload.updated_at})`);
        return;
      }
    }
    if (!local && pushed) {
      // Created from this app moments ago: the local save is still running (or was rolled back).
      this.logger.log(`${d.topic} ${gid} ignored: product was just created from this app`);
      return;
    }
    if (Array.isArray(d.payload?.variants) && d.payload.variants.length > 1) {
      this.logger.log(`${d.topic} ${gid} skipped: ${d.payload.variants.length} variants (only single-variant products are synced)`);
      return;
    }

    const node = await this.importer.fetchProduct(d.shop, gid);
    if (!node) {
      this.logger.log(`${d.topic} ${gid} ignored: Shopify no longer has the product`);
      return;
    }
    const outcome = await this.importer.upsert(node);
    if (outcome.result === 'skipped') this.logger.log(`${d.topic} "${node.title}" (${gid}) skipped: ${outcome.reason}`);
    else this.logger.log(`${d.topic} "${node.title}" (${gid}) → local product ${outcome.productId} ${outcome.result}`);
  }

  /** products/delete: delete locally, or only unlink when the product is on orders. */
  private async productDeleted(d: WebhookDelivery) {
    const numeric = numericIdFromRaw(d.raw, 'id', d.payload?.id);
    if (!numeric) {
      this.logger.warn('products/delete: payload has no product id');
      return;
    }
    const gid = `gid://shopify/Product/${numeric}`;
    const local = await this.prisma.product.findUnique({ where: { shopifyProductId: gid }, select: { id: true } });
    if (!local) return;

    if (!(await this.prisma.orderItem.count({ where: { productId: local.id } }))) {
      try {
        await this.prisma.product.deleteMany({ where: { id: local.id, shopifyProductId: gid } });
        this.logger.log(`products/delete ${gid} → local product ${local.id} deleted`);
        return;
      } catch (e) {
        if (!isPrismaError(e, FK_VIOLATION)) throw e; // put on an order meanwhile: unlink instead
      }
    }
    await this.prisma.product.updateMany({
      where: { id: local.id, shopifyProductId: gid },
      data: { shopifyProductId: null, shopifyVariantId: null, shopifyInventoryItemId: null, shopifySyncedAt: null },
    });
    this.logger.log(`products/delete ${gid} → local product ${local.id} is on orders: kept and unlinked`);
  }

  /** inventory_levels/update at the primary location: local stock = Shopify's "available". */
  private async inventoryLevelUpdated(d: WebhookDelivery) {
    // admin_graphql_api_id: "gid://shopify/InventoryLevel/<location id>?inventory_item_id=<item id>"
    const levelGid = typeof d.payload?.admin_graphql_api_id === 'string' ? d.payload.admin_graphql_api_id : '';
    const fromGid = /InventoryLevel\/(\d+)\?inventory_item_id=(\d+)/.exec(levelGid);
    const itemId = fromGid?.[2] ?? numericIdFromRaw(d.raw, 'inventory_item_id', d.payload?.inventory_item_id);
    const locationId = fromGid?.[1] ?? numericIdFromRaw(d.raw, 'location_id', d.payload?.location_id);
    const available = d.payload?.available;
    if (!itemId || !locationId || !Number.isInteger(available)) {
      this.logger.warn('inventory_levels/update: payload without inventory item, location or available quantity');
      return;
    }

    const itemGid = `gid://shopify/InventoryItem/${itemId}`;
    const product = await this.prisma.product.findUnique({
      where: { shopifyInventoryItemId: itemGid },
      select: { id: true, stock: true },
    });
    if (!product) return;

    const primary = await this.sync.getLocationId(d.shop);
    if (primary !== `gid://shopify/Location/${locationId}`) return; // we only mirror the primary location

    if (this.sync.consumeStockEcho(itemGid, available)) {
      this.logger.log(`inventory_levels/update ${itemGid} = ${available} ignored: our own stock push`);
      return;
    }
    if (product.stock === available) return;
    await this.prisma.product.updateMany({
      where: { id: product.id, shopifyInventoryItemId: itemGid },
      data: { stock: available },
    });
    this.logger.log(`inventory_levels/update → local product ${product.id} stock ${product.stock} → ${available}`);
  }

  /** app/uninstalled: the token is dead; forget the shop. Products stay as they are. */
  private async uninstalled(shop: string) {
    const { count } = await this.prisma.shop.deleteMany({ where: { domain: shop } });
    this.sync.forgetLocation(shop);
    this.logger.log(`app/uninstalled from ${shop}: ${count ? 'saved access token deleted' : 'no saved token'}`);
  }
}
