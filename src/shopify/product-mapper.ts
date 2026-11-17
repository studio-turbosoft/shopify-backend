/**
 * Pure mapping between our single-variant Product and Shopify Admin GraphQL (2026-10):
 * product → productSet / inventorySetQuantities inputs, and (at the bottom) Shopify product → our
 * columns for the import and webhooks. No Nest / Prisma imports, so it is easy to unit test.
 *
 * productSet:             https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productSet
 * ProductSetInput:        https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/ProductSetInput
 * ProductVariantSetInput: https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/ProductVariantSetInput
 * InventoryItemInput:     https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/InventoryItemInput
 */

export type ProductStatusValue = 'active' | 'draft' | 'archived';
export type WeightUnitValue = 'kg' | 'g' | 'lb' | 'oz';

/** Our product as plain values (money and weight as numbers). */
export interface ProductSnapshot {
  name: string;
  description: string | null;
  status: ProductStatusValue;
  imageUrl: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  price: number;
  compareAtPrice: number | null;
  costPerItem: number | null;
  chargeTax: boolean;
  sku: string | null;
  barcode: string | null;
  trackInventory: boolean;
  continueSellingWhenOutOfStock: boolean;
  stock: number;
  requiresShipping: boolean;
  weight: number | null;
  weightUnit: WeightUnitValue;
}

/** The Shopify objects a local product is linked to (GIDs). */
export interface ShopifyLink {
  productId: string;
  variantId: string | null;
}

export interface ProductSetOptions {
  /** Existing Shopify product/variant to update. Omit to create a new product. */
  link?: ShopifyLink | null;
  /** Location whose "available" quantity is set to `stock` (tracked products only). */
  locationId: string | null;
  /**
   * Send `files` (the image). productSet treats files as a list field: whatever is sent replaces
   * the product's files, so only send it when the image changed or the product is new; otherwise
   * every save would re-upload the same image.
   */
  includeImage: boolean;
}

/** Shopify represents a product without options as one option "Title" with the value "Default Title". */
export const DEFAULT_OPTION_NAME = 'Title';
export const DEFAULT_OPTION_VALUE = 'Default Title';

const STATUS: Record<ProductStatusValue, 'ACTIVE' | 'DRAFT' | 'ARCHIVED'> = {
  active: 'ACTIVE',
  draft: 'DRAFT',
  archived: 'ARCHIVED',
};

const WEIGHT_UNIT: Record<WeightUnitValue, 'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES'> = {
  kg: 'KILOGRAMS',
  g: 'GRAMS',
  lb: 'POUNDS',
  oz: 'OUNCES',
};

/** Money / Decimal scalars are sent as strings, e.g. "19.90". */
export const toMoney = (n: number): string => n.toFixed(2);

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Plain-text description → safe HTML: HTML is escaped, blank lines start a new <p>,
 * single line breaks become <br>. Empty/blank → "".
 */
export function toDescriptionHtml(text: string | null | undefined): string {
  if (!text || !text.trim()) return '';
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n\s*\n/)
    .map((para) => `<p>${para.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('');
}

/** Variables for the productSet mutation (synchronous) for one product. */
export function toProductSetVariables(p: ProductSnapshot, opts: ProductSetOptions) {
  const link = opts.link ?? null;
  const updating = !!link;

  const input: Record<string, unknown> = {
    title: p.name,
    descriptionHtml: toDescriptionHtml(p.description),
    status: STATUS[p.status],
    tags: p.tags,
    productOptions: [{ name: DEFAULT_OPTION_NAME, values: [{ name: DEFAULT_OPTION_VALUE }] }],
    variants: [toVariantInput(p, link?.variantId ?? null, opts.locationId)],
  };

  // On create, leave unset fields to Shopify's defaults. On update, "" clears productType.
  if (p.productType) input.productType = p.productType;
  else if (updating) input.productType = '';
  // Vendor is only sent when set: Shopify fills in the shop name when it's blank, so we
  // never send "" (clearing the vendor locally leaves Shopify's value as is).
  if (p.vendor) input.vendor = p.vendor;

  if (opts.includeImage) {
    input.files = p.imageUrl ? [{ originalSource: p.imageUrl, alt: p.name, contentType: 'IMAGE' }] : [];
  }

  return {
    ...(link ? { identifier: { id: link.productId } } : {}),
    synchronous: true,
    input,
  };
}

function toVariantInput(p: ProductSnapshot, variantId: string | null, locationId: string | null) {
  const variant: Record<string, unknown> = {
    optionValues: [{ optionName: DEFAULT_OPTION_NAME, name: DEFAULT_OPTION_VALUE }],
    price: toMoney(p.price),
    compareAtPrice: p.compareAtPrice == null ? null : toMoney(p.compareAtPrice),
    sku: p.sku ?? null,
    // `barcode` is deprecated in 2026-10; `barcodes` replaces the whole set ([] clears it).
    barcodes: p.barcode ? [{ value: p.barcode }] : [],
    taxable: p.chargeTax,
    inventoryPolicy: p.continueSellingWhenOutOfStock ? 'CONTINUE' : 'DENY',
    inventoryItem: {
      cost: p.costPerItem == null ? null : toMoney(p.costPerItem),
      tracked: p.trackInventory,
      requiresShipping: p.requiresShipping,
      // No weight → 0, which is what Shopify shows for "no weight".
      measurement: { weight: { value: p.weight ?? 0, unit: WEIGHT_UNIT[p.weightUnit] } },
    },
  };
  if (variantId) variant.id = variantId;
  // Untracked products have no meaningful quantity, so it isn't sent.
  if (p.trackInventory && locationId) {
    variant.inventoryQuantities = [{ locationId, name: 'available', quantity: p.stock }];
  }
  return variant;
}

/** Variables for inventorySetQuantities: set "available" to our absolute stock (no compare-and-swap). */
export function toInventorySetVariables(
  items: { inventoryItemId: string; stock: number }[],
  locationId: string,
  idempotencyKey: string,
  referenceDocumentUri?: string,
) {
  return {
    idempotencyKey,
    input: {
      name: 'available',
      // "correction": general adjustment; our database is the source of truth for stock.
      reason: 'correction',
      ...(referenceDocumentUri ? { referenceDocumentUri } : {}),
      quantities: items.map((i) => ({
        inventoryItemId: i.inventoryItemId,
        locationId,
        quantity: i.stock,
        // Required since 2026-04; null explicitly opts out of the compare-and-swap check.
        changeFromQuantity: null,
      })),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Shopify → our Product (import and webhooks). Reads the fields selected by SYNC_PRODUCT_FIELDS
// in product-import.service.ts:
//   products query: https://shopify.dev/docs/api/admin-graphql/2026-10/queries/products
//   Product:        https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Product
//   ProductVariant: https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ProductVariant
//   InventoryItem:  https://shopify.dev/docs/api/admin-graphql/2026-10/objects/InventoryItem
// ---------------------------------------------------------------------------------------------

/** One product as returned by the sync query (only the fields we map). */
export interface ShopifyProductNode {
  id: string;
  title: string;
  descriptionHtml: string | null;
  status: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  /** ISO date-time; stored as shopifySyncedAt and compared by the webhook loop guard. */
  updatedAt: string;
  hasOnlyDefaultVariant: boolean;
  variantsCount: { count: number; precision?: string } | null;
  featuredMedia: {
    mediaContentType: string;
    preview: { image: { url: string } | null } | null;
  } | null;
  variants: { nodes: ShopifyVariantNode[] };
}

export interface ShopifyVariantNode {
  id: string;
  price: string;
  compareAtPrice: string | null;
  sku: string | null;
  taxable: boolean;
  inventoryPolicy: string;
  barcodes: { nodes: { value: string }[] } | null;
  inventoryItem: {
    id: string;
    tracked: boolean;
    requiresShipping: boolean;
    unitCost: { amount: string } | null;
    measurement: { weight: { value: number; unit: string } | null } | null;
    /** Level at the shop's primary location (null when the item isn't stocked there). */
    inventoryLevel: { quantities: { name: string; quantity: number }[] } | null;
  } | null;
}

/** A Shopify product converted to our columns, ready to upsert. */
export interface ShopifyProductImport {
  shopifyProductId: string;
  shopifyVariantId: string;
  shopifyInventoryItemId: string;
  /** Shopify's product.updatedAt; stored as shopifySyncedAt. */
  updatedAt: Date;
  /**
   * The product values. `imageUrl` is left out when Shopify's image is still processing
   * (no URL yet): keep whatever we have instead of clearing it.
   */
  data: Omit<ProductSnapshot, 'imageUrl'> & { imageUrl?: string | null };
}

export type ShopifyProductMapResult =
  | { ok: true; product: ShopifyProductImport }
  | { ok: false; reason: string };

/** Longest SKU our column takes (Shopify allows 255). */
export const MAX_SKU_LENGTH = 64;

const STATUS_FROM_SHOPIFY: Record<string, ProductStatusValue> = {
  ACTIVE: 'active',
  DRAFT: 'draft',
  ARCHIVED: 'archived',
};

const WEIGHT_UNIT_FROM_SHOPIFY: Record<string, WeightUnitValue> = {
  KILOGRAMS: 'kg',
  GRAMS: 'g',
  POUNDS: 'lb',
  OUNCES: 'oz',
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode HTML entities in one pass (so "&amp;lt;" becomes "&lt;", not "<"). Unknown ones are kept. */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const n = hex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return whole;
      return n === 0xa0 ? ' ' : String.fromCodePoint(n);
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * Shopify descriptionHtml → our plain-text description (the reverse of toDescriptionHtml):
 * <br> → line break, end of a paragraph / heading / list → blank line, list items → "- item",
 * other tags are dropped and entities decoded. Empty → null.
 */
export function fromDescriptionHtml(html: string | null | undefined): string | null {
  if (!html || !html.trim()) return null;
  const text = html
    // Line breaks in the HTML source are just whitespace.
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|ul|ol|blockquote|pre|table|section|article)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
  const plain = decodeHtmlEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain || null;
}

/** Money / Decimal strings ("19.90") → number; null, blank or invalid → null. */
const parseAmount = (s: string | null | undefined): number | null => {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Shopify product → our columns. Products our single-variant model can't hold are refused with
 * a reason: they are reported and never written, because pushing one back with productSet
 * (single variant, default option) would delete its other variants / options in Shopify.
 */
export function fromShopifyProduct(node: ShopifyProductNode): ShopifyProductMapResult {
  const variantCount = Math.max(node.variantsCount?.count ?? 0, node.variants.nodes.length);
  if (variantCount > 1) {
    return { ok: false, reason: `has ${variantCount} variants; only single-variant products are supported` };
  }
  if (!node.hasOnlyDefaultVariant) {
    return { ok: false, reason: 'uses product options (e.g. Size or Color); only products without options are supported' };
  }
  const variant = node.variants.nodes[0];
  const item = variant?.inventoryItem;
  if (!variant || !item) return { ok: false, reason: 'has no variant' };

  const status = STATUS_FROM_SHOPIFY[node.status];
  if (!status) return { ok: false, reason: `status ${node.status} isn't supported` };

  const sku = variant.sku?.trim() || null;
  if (sku && sku.length > MAX_SKU_LENGTH) {
    return { ok: false, reason: `SKU is longer than ${MAX_SKU_LENGTH} characters` };
  }
  const price = parseAmount(variant.price);
  if (price == null) return { ok: false, reason: 'has no price' };
  const updatedAt = new Date(node.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) return { ok: false, reason: 'has no valid updatedAt' };

  const weight = item.measurement?.weight ?? null;
  // Same definition the push uses: "available" at the primary location. Not stocked there → 0.
  const available = item.inventoryLevel?.quantities.find((q) => q.name === 'available')?.quantity ?? 0;

  const data: ShopifyProductImport['data'] = {
    name: node.title,
    description: fromDescriptionHtml(node.descriptionHtml),
    status,
    productType: node.productType?.trim() || null,
    vendor: node.vendor?.trim() || null,
    tags: node.tags ?? [],
    price,
    compareAtPrice: parseAmount(variant.compareAtPrice),
    costPerItem: parseAmount(item.unitCost?.amount),
    chargeTax: variant.taxable,
    sku,
    barcode: variant.barcodes?.nodes[0]?.value || null,
    trackInventory: item.tracked,
    continueSellingWhenOutOfStock: variant.inventoryPolicy === 'CONTINUE',
    stock: available,
    requiresShipping: item.requiresShipping,
    // The push sends 0 for "no weight", so 0 maps back to null.
    weight: weight && weight.value > 0 ? weight.value : null,
    weightUnit: (weight && WEIGHT_UNIT_FROM_SHOPIFY[weight.unit]) || 'kg',
  };

  // Only images map to imageUrl. No featured media → null; an image still processing (no URL yet)
  // → leave imageUrl out so the local value is kept.
  const media = node.featuredMedia;
  if (!media || media.mediaContentType !== 'IMAGE') data.imageUrl = null;
  else if (media.preview?.image?.url) data.imageUrl = media.preview.image.url;

  return {
    ok: true,
    product: {
      shopifyProductId: node.id,
      shopifyVariantId: variant.id,
      shopifyInventoryItemId: item.id,
      updatedAt,
      data,
    },
  };
}
