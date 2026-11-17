/**
 * Pure mapping from our single-variant Product to the Shopify Admin GraphQL (2026-10) inputs.
 * No Nest / Prisma imports, so it is easy to unit test.
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
