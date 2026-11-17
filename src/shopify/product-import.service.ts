import { Injectable, Logger } from '@nestjs/common';
import type { ShopifySession } from '../auth/shopify-session.guard';
import { isPrismaError, UNIQUE_VIOLATION } from '../common/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { fromShopifyProduct, type ShopifyProductNode } from './product-mapper';
import { ProductSyncService } from './product-sync.service';
import { ShopifyAdminService } from './shopify-admin.service';

// Admin GraphQL 2026-10, read only: products / product need read_products (write_products implies
// it); inventoryItem / inventoryLevel need read_inventory; the primary location needs read_locations.

/**
 * Everything our Product maps, for one Shopify product. Stock is "available" at the primary
 * location: the same quantity the push sets, so both directions agree.
 * https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Product
 */
const SYNC_PRODUCT_FIELDS = `#graphql
  fragment SyncProductFields on Product {
    id
    title
    descriptionHtml
    status
    productType
    vendor
    tags
    updatedAt
    hasOnlyDefaultVariant
    variantsCount { count precision }
    featuredMedia {
      mediaContentType
      preview { image { url } }
    }
    metafields(namespace: "custom", first: 10) {
      nodes { key value }
    }
    variants(first: 1) {
      nodes {
        id
        price
        compareAtPrice
        sku
        taxable
        inventoryPolicy
        barcodes(first: 1) { nodes { value } }
        inventoryItem {
          id
          tracked
          requiresShipping
          unitCost { amount }
          measurement { weight { value unit } }
          inventoryLevel(locationId: $locationId) {
            quantities(names: ["available"]) { name quantity }
          }
        }
      }
    }
  }`;

/**
 * https://shopify.dev/docs/api/admin-graphql/2026-10/queries/products
 * Page size: each product costs about 28 points here (nested connections, incl. 10 metafields), and a
 * single query may cost at most 1,000, so 100 per page would be refused; 25 keeps a page around 700.
 */
const PRODUCTS_QUERY = `#graphql
  query SyncProducts($first: Int!, $after: String, $locationId: ID!) {
    products(first: $first, after: $after, sortKey: ID) {
      nodes { ...SyncProductFields }
      pageInfo { hasNextPage endCursor }
    }
  }
  ${SYNC_PRODUCT_FIELDS}`;

/** https://shopify.dev/docs/api/admin-graphql/2026-10/queries/product */
const PRODUCT_QUERY = `#graphql
  query SyncProduct($id: ID!, $locationId: ID!) {
    product(id: $id) { ...SyncProductFields }
  }
  ${SYNC_PRODUCT_FIELDS}`;

const SYNC_PAGE_SIZE = 25;

interface ProductsPage {
  products: {
    nodes: ShopifyProductNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export interface SkippedProduct {
  title: string;
  reason: string;
}

/** Result of POST /api/shopify/sync. */
export interface SyncSummary {
  /** New local products. */
  created: number;
  /** Local products already linked to the Shopify product, updated from it. */
  updated: number;
  /** Unlinked local products with the same SKU, now linked and updated. */
  linked: number;
  /** Shopify products that were not written, with the reason. */
  skipped: SkippedProduct[];
  /** Shopify products read. */
  total: number;
}

export type UpsertOutcome =
  | { result: 'created' | 'updated' | 'linked'; productId: number }
  | { result: 'skipped'; reason: string };

const skipped = (reason: string): UpsertOutcome => ({ result: 'skipped', reason });

/**
 * Shopify → our database. Used by the "Sync from Shopify" import and by the products webhooks.
 * Never writes to Shopify.
 */
@Injectable()
export class ProductImportService {
  private readonly logger = new Logger(ProductImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: ShopifyAdminService,
    private readonly sync: ProductSyncService,
  ) {}

  /** Read every product of the session's store and upsert the single-variant ones. */
  async importAll(session: ShopifySession): Promise<SyncSummary> {
    const locationId = await this.sync.getLocationId(session);
    const summary: SyncSummary = { created: 0, updated: 0, linked: 0, skipped: [], total: 0 };

    let after: string | null = null;
    do {
      const page: ProductsPage = await this.admin.graphql<ProductsPage>(session, PRODUCTS_QUERY, {
        first: SYNC_PAGE_SIZE,
        after,
        locationId,
      });
      for (const node of page.products.nodes) {
        summary.total++;
        let outcome: UpsertOutcome;
        try {
          outcome = await this.upsert(node);
        } catch (e) {
          this.logger.error(`Import of Shopify product ${node.id} failed: ${(e as Error).message}`);
          outcome = skipped('could not be saved (see server log)');
        }
        if (outcome.result === 'skipped') summary.skipped.push({ title: node.title, reason: outcome.reason });
        else summary[outcome.result]++;
      }
      after = page.products.pageInfo.hasNextPage ? page.products.pageInfo.endCursor : null;
    } while (after);

    this.logger.log(
      `Synced from ${session.shop}: ${summary.total} read, ${summary.created} created, ${summary.updated} updated, ` +
        `${summary.linked} linked, ${summary.skipped.length} skipped`,
    );
    return summary;
  }

  /**
   * One product, read with the shop's saved offline token (webhooks have no session).
   * Null when Shopify doesn't have it (anymore). Throws ShopNotConnectedError without a token.
   */
  async fetchProduct(shop: string, shopifyProductId: string): Promise<ShopifyProductNode | null> {
    const locationId = await this.sync.getLocationId(shop);
    const data = await this.admin.graphqlForShop<{ product: ShopifyProductNode | null }>(shop, PRODUCT_QUERY, {
      id: shopifyProductId,
      locationId,
    });
    return data.product;
  }

  /**
   * Write one Shopify product locally:
   *  1. a local product linked to it (shopifyProductId) → update;
   *  2. else an unlinked local product with the same SKU → link + update;
   *  3. else create.
   * shopifySyncedAt = Shopify's updatedAt. A linked product whose shopifySyncedAt is newer than
   * what was read (pushed from here in the meantime) is left alone.
   */
  async upsert(node: ShopifyProductNode): Promise<UpsertOutcome> {
    const mapped = fromShopifyProduct(node);
    if (!mapped.ok) return skipped(mapped.reason);
    const p = mapped.product;
    const data = {
      ...p.data,
      metafields: p.metafields,
      shopifyProductId: p.shopifyProductId,
      shopifyVariantId: p.shopifyVariantId,
      shopifyInventoryItemId: p.shopifyInventoryItemId,
      shopifySyncedAt: p.updatedAt,
    };

    // Second attempt: a concurrent import / webhook created or linked the row first.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const linked = await this.prisma.product.findUnique({ where: { shopifyProductId: p.shopifyProductId } });
        if (linked) {
          const { count } = await this.prisma.product.updateMany({
            where: {
              id: linked.id,
              shopifyProductId: p.shopifyProductId,
              OR: [{ shopifySyncedAt: null }, { shopifySyncedAt: { lte: p.updatedAt } }],
            },
            data,
          });
          if (!count) return skipped('was changed in this app after it was read from Shopify; kept the local version');
          return { result: 'updated', productId: linked.id };
        }

        if (p.data.sku) {
          const sameSku = await this.prisma.product.findUnique({ where: { sku: p.data.sku } });
          if (sameSku?.shopifyProductId) {
            return skipped(`SKU "${p.data.sku}" is already used by "${sameSku.name}", which is linked to another Shopify product`);
          }
          if (sameSku) {
            const { count } = await this.prisma.product.updateMany({
              where: { id: sameSku.id, shopifyProductId: null },
              data,
            });
            if (count) return { result: 'linked', productId: sameSku.id };
            continue; // linked by someone else meanwhile
          }
        }

        const created = await this.prisma.product.create({ data });
        return { result: 'created', productId: created.id };
      } catch (e) {
        if (!isPrismaError(e, UNIQUE_VIOLATION)) throw e;
        if (attempt === 1) {
          return skipped('clashes with another local product (same SKU, Shopify variant or inventory item)');
        }
      }
    }
    return skipped('was changed concurrently; try again');
  }
}
