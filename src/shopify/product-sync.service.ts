import { BadGatewayException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ShopifySession } from '../auth/shopify-session.guard';
import { PrismaService } from '../prisma/prisma.service';
import { TtlMap } from '../common/ttl-map';
import { ShopifyAdminService } from './shopify-admin.service';
import {
  type ProductSnapshot,
  type ShopifyLink,
  toInventorySetVariables,
  toProductSetVariables,
} from './product-mapper';

// Admin GraphQL 2026-10. Scopes: productSet / productDelete need write_products,
// inventorySetQuantities needs write_inventory, the Location object needs read_locations
// (or read_inventory).

/** https://shopify.dev/docs/api/admin-graphql/2026-10/queries/location (no id → the shop's primary location) */
const PRIMARY_LOCATION_QUERY = `#graphql
  query PrimaryLocation {
    location { id name isActive }
  }`;

/** https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productSet */
const PRODUCT_SET_MUTATION = `#graphql
  mutation ProductSet($input: ProductSetInput!, $identifier: ProductSetIdentifiers, $synchronous: Boolean!) {
    productSet(input: $input, identifier: $identifier, synchronous: $synchronous) {
      product {
        id
        updatedAt
        variants(first: 1) {
          nodes { id inventoryItem { id } }
        }
      }
      userErrors { code field message }
    }
  }`;

/** https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productDelete */
const PRODUCT_DELETE_MUTATION = `#graphql
  mutation ProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }`;

/**
 * https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/inventorySetQuantities
 * Since 2026-04 the @idempotent key is required.
 */
const INVENTORY_SET_MUTATION = `#graphql
  mutation InventorySet($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup { id }
      userErrors { code field message }
    }
  }`;

interface UserError {
  code?: string | null;
  field?: string[] | null;
  message: string;
}

interface ProductSetResult {
  productSet: {
    product: {
      id: string;
      updatedAt: string;
      variants: { nodes: { id: string; inventoryItem: { id: string } | null }[] };
    } | null;
    userErrors: UserError[];
  };
}

/** The Shopify IDs a product is linked to after a push. */
export interface ShopifyProductIds {
  shopifyProductId: string;
  shopifyVariantId: string;
  shopifyInventoryItemId: string;
  /** True when this push created the product in Shopify (so it can be rolled back). */
  created: boolean;
  /** Shopify's product.updatedAt after the push; saved as shopifySyncedAt (webhook loop guard). */
  updatedAt: Date;
}

/** How long our own pushes are remembered, to recognise the webhooks they trigger. */
const ECHO_TTL_MS = 10 * 60_000;

const NOT_FOUND_CODES = new Set(['PRODUCT_DOES_NOT_EXIST', 'NOT_FOUND']);
const VARIANT_NOT_FOUND_CODES = new Set(['PRODUCT_VARIANT_DOES_NOT_EXIST']);

const formatUserErrors = (errors: UserError[]) =>
  errors.map((e) => (e.field?.length ? `${e.field.join('.')}: ${e.message}` : e.message)).join('; ');

/**
 * Pushes our products to Shopify. The mapping itself lives in product-mapper.ts.
 * Our database is the source of truth: Shopify is written first and local saves only
 * happen after Shopify accepted the change (see ProductsService).
 */
@Injectable()
export class ProductSyncService {
  private readonly logger = new Logger(ProductSyncService.name);
  /** Primary location per shop, looked up once per process. */
  private readonly locations = new Map<string, Promise<string>>();
  /**
   * Loop guard, in memory: Shopify product GID → product.updatedAt of our last push. Covers the
   * moment between productSet and the local save, when shopifySyncedAt isn't stored yet.
   */
  private readonly pushedProducts = new TtlMap<string, Date>(ECHO_TTL_MS);
  /** Inventory item GID → "available" quantities we set recently (their inventory_levels/update echoes). */
  private readonly pushedStock = new TtlMap<string, number[]>(ECHO_TTL_MS);

  constructor(
    private readonly admin: ShopifyAdminService,
    private readonly prisma: PrismaService,
  ) {}

  /** One-line warning for writes made without a Shopify session (local dev with SHOPIFY_AUTH=off). */
  warnNoSession(what: string) {
    this.logger.warn(`No Shopify session: ${what} saved locally only, not pushed to Shopify`);
  }

  /**
   * The shop's primary location (cached in memory). Pass the session, or just the shop domain to
   * call with its saved offline token (webhooks).
   */
  async getLocationId(target: ShopifySession | string): Promise<string> {
    const shop = typeof target === 'string' ? target : target.shop;
    let pending = this.locations.get(shop);
    if (!pending) {
      type Result = { location: { id: string; name: string; isActive: boolean } | null };
      const call =
        typeof target === 'string'
          ? this.admin.graphqlForShop<Result>(shop, PRIMARY_LOCATION_QUERY)
          : this.admin.graphql<Result>(target, PRIMARY_LOCATION_QUERY);
      pending = call.then(({ location }) => {
        if (!location) throw new BadGatewayException('Shopify returned no primary location for this store');
        this.logger.log(`Using location "${location.name}" (${location.id}) for ${shop}`);
        return location.id;
      });
      this.locations.set(shop, pending);
      // Don't cache failures.
      pending.catch(() => this.locations.delete(shop));
    }
    return pending;
  }

  /** Drop the cached primary location (it changed, or the app was uninstalled). */
  forgetLocation(shop: string) {
    this.locations.delete(shop);
  }

  /** Our last push of this Shopify product (its updatedAt), if it was in the last few minutes. */
  recentProductPush(shopifyProductId: string): Date | undefined {
    return this.pushedProducts.get(shopifyProductId);
  }

  /**
   * True if we set this item's "available" to `quantity` in the last few minutes, i.e. an
   * inventory_levels/update with that value is the echo of our own push. Each push matches once.
   */
  consumeStockEcho(inventoryItemId: string, quantity: number): boolean {
    const pushed = this.pushedStock.get(inventoryItemId);
    const i = pushed ? pushed.indexOf(quantity) : -1;
    if (!pushed || i === -1) return false;
    const rest = pushed.filter((_, j) => j !== i);
    if (rest.length) this.pushedStock.set(inventoryItemId, rest);
    else this.pushedStock.delete(inventoryItemId);
    return true;
  }

  private rememberStockPush(inventoryItemId: string, quantity: number) {
    const pushed = [...(this.pushedStock.get(inventoryItemId) ?? []), quantity].slice(-20);
    this.pushedStock.set(inventoryItemId, pushed);
  }

  /**
   * Create or update the product in Shopify with productSet. With `link` the linked product is
   * updated; if Shopify no longer has it (deleted in the Shopify admin) it is created again.
   * Throws 422 with Shopify's userErrors, or 502 when Shopify can't be reached.
   */
  async pushProduct(
    session: ShopifySession,
    product: ProductSnapshot,
    link: ShopifyLink | null,
    includeImage: boolean,
  ): Promise<ShopifyProductIds> {
    const locationId = product.trackInventory ? await this.getLocationId(session) : null;

    let result = await this.productSet(session, product, link, locationId, includeImage);
    if (link && result.userErrors.some((e) => e.code && NOT_FOUND_CODES.has(e.code))) {
      this.logger.warn(`Shopify product ${link.productId} no longer exists; creating it again`);
      link = null;
      result = await this.productSet(session, product, null, locationId, true);
    } else if (link?.variantId && result.userErrors.some((e) => e.code && VARIANT_NOT_FOUND_CODES.has(e.code))) {
      this.logger.warn(`Shopify variant ${link.variantId} no longer exists; replacing it`);
      link = { productId: link.productId, variantId: null };
      result = await this.productSet(session, product, link, locationId, includeImage);
    }

    if (result.userErrors.length) {
      if (result.userErrors.some((e) => /location/i.test(e.message))) this.forgetLocation(session.shop);
      throw new UnprocessableEntityException(`Shopify rejected the product: ${formatUserErrors(result.userErrors)}`);
    }
    const variant = result.product?.variants.nodes[0];
    if (!result.product || !variant?.inventoryItem) {
      throw new BadGatewayException('Shopify did not return the saved product and variant');
    }
    const updatedAt = new Date(result.product.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) throw new BadGatewayException('Shopify did not return product.updatedAt');
    this.pushedProducts.set(result.product.id, updatedAt);
    if (locationId) this.rememberStockPush(variant.inventoryItem.id, product.stock);
    return {
      shopifyProductId: result.product.id,
      shopifyVariantId: variant.id,
      shopifyInventoryItemId: variant.inventoryItem.id,
      created: !link,
      updatedAt,
    };
  }

  private async productSet(
    session: ShopifySession,
    product: ProductSnapshot,
    link: ShopifyLink | null,
    locationId: string | null,
    includeImage: boolean,
  ) {
    const variables = toProductSetVariables(product, { link, locationId, includeImage });
    const data = await this.admin.graphql<ProductSetResult>(session, PRODUCT_SET_MUTATION, variables);
    return data.productSet;
  }

  /** Delete the product in Shopify. A product Shopify doesn't have counts as deleted. */
  async deleteProduct(session: ShopifySession, shopifyProductId: string): Promise<void> {
    const data = await this.admin.graphql<{
      productDelete: { deletedProductId: string | null; userErrors: UserError[] };
    }>(session, PRODUCT_DELETE_MUTATION, { input: { id: shopifyProductId } });

    const errors = data.productDelete.userErrors.filter((e) => !/not (be )?found|does not exist|doesn't exist/i.test(e.message));
    if (errors.length) {
      throw new UnprocessableEntityException(`Shopify could not delete the product: ${formatUserErrors(errors)}`);
    }
    if (!data.productDelete.deletedProductId) {
      this.logger.warn(`Shopify product ${shopifyProductId} was already gone; deleting locally`);
    }
  }

  /** Roll back a product this request created in Shopify. Never throws; failures are logged. */
  async deleteProductQuietly(session: ShopifySession, shopifyProductId: string): Promise<void> {
    try {
      await this.deleteProduct(session, shopifyProductId);
      this.logger.warn(`Rolled back Shopify product ${shopifyProductId} after the local save failed`);
    } catch (e) {
      this.logger.error(
        `Could not roll back Shopify product ${shopifyProductId}; delete it in the Shopify admin: ${(e as Error).message}`,
      );
    }
  }

  /**
   * After an order changed stock: push the current stock of these products to Shopify.
   * Best effort, never throws. Products that couldn't be pushed (or with no session) get
   * shopifySyncedAt = null, meaning "out of sync". Untracked and unlinked products are skipped.
   * A successful push leaves shopifySyncedAt as is: it holds Shopify's product.updatedAt, which
   * inventory changes don't bump.
   */
  async syncStock(session: ShopifySession | undefined, productIds: number[], orderId?: number): Promise<void> {
    if (!productIds.length) return;
    try {
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds }, trackInventory: true, shopifyInventoryItemId: { not: null } },
        select: { id: true, stock: true, shopifyInventoryItemId: true },
      });
      if (!products.length) return;

      if (!session) {
        this.warnNoSession(`stock of product(s) ${products.map((p) => p.id).join(', ')}`);
        await this.markOutOfSync(products.map((p) => p.id));
        return;
      }

      const locationId = await this.getLocationId(session);
      for (const p of products) {
        try {
          await this.setAvailable(session, p.shopifyInventoryItemId!, p.stock, locationId, orderId);
        } catch (e) {
          this.logger.error(`Stock sync to Shopify failed for product ${p.id}: ${(e as Error).message}`);
          await this.markOutOfSync([p.id]);
        }
      }
    } catch (e) {
      this.logger.error(`Stock sync to Shopify failed for product(s) ${productIds.join(', ')}: ${(e as Error).message}`);
      await this.markOutOfSync(productIds);
    }
  }

  /** Set "available" at the location to an absolute quantity. */
  async setAvailable(
    session: ShopifySession,
    inventoryItemId: string,
    stock: number,
    locationId: string,
    orderId?: number,
  ): Promise<void> {
    // One key per logical change; ShopifyAdminService's 401 retry resends the same variables, so it is reused.
    const variables = toInventorySetVariables(
      [{ inventoryItemId, stock }],
      locationId,
      randomUUID(),
      orderId ? `gid://shopify-nest/Order/${orderId}` : undefined,
    );
    const data = await this.admin.graphql<{ inventorySetQuantities: { userErrors: UserError[] } }>(
      session,
      INVENTORY_SET_MUTATION,
      variables,
    );
    const errors = data.inventorySetQuantities.userErrors;
    if (errors.length) {
      if (errors.some((e) => e.code === 'INVALID_LOCATION')) this.forgetLocation(session.shop);
      throw new UnprocessableEntityException(`Shopify rejected the stock update: ${formatUserErrors(errors)}`);
    }
    this.rememberStockPush(inventoryItemId, stock);
  }

  /** shopifySyncedAt = null: the product no longer matches Shopify. Never throws. */
  async markOutOfSync(productIds: number[]): Promise<void> {
    try {
      await this.prisma.product.updateMany({ where: { id: { in: productIds } }, data: { shopifySyncedAt: null } });
    } catch (e) {
      this.logger.error(`Could not mark product(s) ${productIds.join(', ')} out of sync: ${(e as Error).message}`);
    }
  }
}
