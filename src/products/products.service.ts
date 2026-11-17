import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Product } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toNumber, toNumberOrNull } from '../common/decimal';
import { FK_VIOLATION, isPrismaError, RECORD_NOT_FOUND, UNIQUE_VIOLATION } from '../common/prisma-errors';
import type { ShopifySession } from '../auth/shopify-session.guard';
import type { ProductSnapshot } from '../shopify/product-mapper';
import { ProductSyncService, type ShopifyProductIds } from '../shopify/product-sync.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

/** API shape: money and weight as numbers instead of Prisma.Decimal. */
export const toProductDto = (p: Product) => ({
  ...p,
  price: toNumber(p.price),
  compareAtPrice: toNumberOrNull(p.compareAtPrice),
  costPerItem: toNumberOrNull(p.costPerItem),
  weight: toNumberOrNull(p.weight),
});

/** A saved product as the plain values the Shopify mapper takes. */
const toSnapshot = (p: Product): ProductSnapshot => ({
  name: p.name,
  description: p.description,
  status: p.status,
  imageUrl: p.imageUrl,
  productType: p.productType,
  vendor: p.vendor,
  tags: p.tags,
  price: toNumber(p.price),
  compareAtPrice: toNumberOrNull(p.compareAtPrice),
  costPerItem: toNumberOrNull(p.costPerItem),
  chargeTax: p.chargeTax,
  sku: p.sku,
  barcode: p.barcode,
  trackInventory: p.trackInventory,
  continueSellingWhenOutOfStock: p.continueSellingWhenOutOfStock,
  stock: p.stock,
  requiresShipping: p.requiresShipping,
  weight: toNumberOrNull(p.weight),
  weightUnit: p.weightUnit,
});

/** Column defaults from schema.prisma, for building the Shopify input of a product not saved yet. */
const NEW_PRODUCT_DEFAULTS: Omit<ProductSnapshot, 'name' | 'price' | 'stock'> = {
  description: null,
  status: 'active',
  imageUrl: null,
  productType: null,
  vendor: null,
  tags: [],
  compareAtPrice: null,
  costPerItem: null,
  chargeTax: true,
  sku: null,
  barcode: null,
  trackInventory: true,
  continueSellingWhenOutOfStock: false,
  requiresShipping: true,
  weight: null,
  weightUnit: 'kg',
};

/** Only the fields actually sent (PartialType DTOs may carry undefined). */
const definedFields = <T extends object>(dto: T): Partial<T> =>
  Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * Products are pushed to Shopify before they are saved here, so the two never silently diverge:
 * if Shopify rejects a change, nothing is saved. Without a Shopify session (local dev with
 * SHOPIFY_AUTH=off) writes are local only and shopifySyncedAt stays null.
 */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: ProductSyncService,
  ) {}

  async findAll() {
    const products = await this.prisma.product.findMany({ orderBy: { id: 'desc' } });
    return products.map(toProductDto);
  }

  async findOne(id: number) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return toProductDto(product);
  }

  async create(dto: CreateProductDto, session?: ShopifySession) {
    await this.assertSkuFree(dto.sku);

    if (!session) {
      this.sync.warnNoSession(`new product "${dto.name}"`);
      return this.saveNew(dto, null);
    }

    const snapshot: ProductSnapshot = { ...NEW_PRODUCT_DEFAULTS, ...(definedFields(dto) as ProductSnapshot) };
    const ids = await this.sync.pushProduct(session, snapshot, null, true);
    try {
      return await this.saveNew(dto, ids);
    } catch (e) {
      await this.sync.deleteProductQuietly(session, ids.shopifyProductId);
      throw e;
    }
  }

  async update(id: number, dto: UpdateProductDto, session?: ShopifySession) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Product ${id} not found`);
    const changes = definedFields(dto);
    if (changes.sku != null && changes.sku !== existing.sku) await this.assertSkuFree(changes.sku, id);

    if (!session) {
      this.sync.warnNoSession(`product ${id}`);
      return this.saveUpdate(id, { ...changes, shopifySyncedAt: null }, changes.sku);
    }

    const snapshot: ProductSnapshot = { ...toSnapshot(existing), ...(changes as Partial<ProductSnapshot>) };
    const link = existing.shopifyProductId
      ? { productId: existing.shopifyProductId, variantId: existing.shopifyVariantId }
      : null;
    // Only resend the image when it changed (or the product is new to Shopify): productSet
    // replaces the product's files with whatever is sent.
    const imageChanged = changes.imageUrl !== undefined && changes.imageUrl !== existing.imageUrl;
    const ids = await this.sync.pushProduct(session, snapshot, link, !link || imageChanged);

    try {
      return await this.saveUpdate(id, { ...changes, ...this.linkData(ids) }, changes.sku);
    } catch (e) {
      if (ids.created) {
        await this.sync.deleteProductQuietly(session, ids.shopifyProductId);
      } else {
        // Shopify already has the change and can't be put back; flag the row as out of sync.
        this.logger.error(`Product ${id} was updated in Shopify but the local save failed: ${(e as Error).message}`);
        await this.sync.markOutOfSync([id]);
      }
      throw e;
    }
  }

  async remove(id: number, session?: ShopifySession) {
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Product ${id} not found`);
    if (await this.prisma.orderItem.count({ where: { productId: id } })) throw this.usedInOrders();

    if (existing.shopifyProductId) {
      if (session) await this.sync.deleteProduct(session, existing.shopifyProductId);
      else this.sync.warnNoSession(`deletion of product ${id} (Shopify product ${existing.shopifyProductId} is left in Shopify)`);
    }

    try {
      await this.prisma.product.delete({ where: { id } });
    } catch (e) {
      // The products/delete webhook for our own productDelete got here first: already gone.
      if (existing.shopifyProductId && isPrismaError(e, RECORD_NOT_FOUND)) return;
      // An order took this product between the check and the delete.
      if (isPrismaError(e, FK_VIOLATION)) {
        if (existing.shopifyProductId && session) {
          this.logger.error(`Product ${id} was deleted in Shopify but is now on an order; it stays locally`);
          await this.sync.markOutOfSync([id]);
        }
        throw this.usedInOrders();
      }
      throw this.mapWriteError(e, undefined, id);
    }
  }

  private async saveNew(dto: CreateProductDto, ids: ShopifyProductIds | null) {
    try {
      const data = ids ? { ...dto, ...this.linkData(ids) } : dto;
      return toProductDto(await this.prisma.product.create({ data }));
    } catch (e) {
      throw this.mapWriteError(e, dto.sku);
    }
  }

  private async saveUpdate(id: number, data: Record<string, unknown>, sku?: string | null) {
    try {
      return toProductDto(await this.prisma.product.update({ where: { id }, data }));
    } catch (e) {
      throw this.mapWriteError(e, sku, id);
    }
  }

  private linkData(ids: ShopifyProductIds) {
    return {
      shopifyProductId: ids.shopifyProductId,
      shopifyVariantId: ids.shopifyVariantId,
      shopifyInventoryItemId: ids.shopifyInventoryItemId,
      // Shopify's product.updatedAt (not our clock): products/update webhooks with an updated_at
      // up to this value are our own change and are ignored.
      shopifySyncedAt: ids.updatedAt,
    };
  }

  /** Checked before calling Shopify, so a duplicate SKU never creates a Shopify product first. */
  private async assertSkuFree(sku: string | null | undefined, exceptId?: number) {
    if (sku == null) return;
    const clash = await this.prisma.product.findFirst({
      where: { sku, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw new ConflictException(`SKU "${sku}" already exists`);
  }

  private usedInOrders() {
    return new ConflictException('Product is used in existing orders and cannot be deleted');
  }

  private mapWriteError(e: unknown, sku?: string | null, id?: number) {
    if (isPrismaError(e, UNIQUE_VIOLATION)) return new ConflictException(`SKU "${sku}" already exists`);
    if (isPrismaError(e, RECORD_NOT_FOUND)) return new NotFoundException(`Product ${id} not found`);
    return e;
  }
}
