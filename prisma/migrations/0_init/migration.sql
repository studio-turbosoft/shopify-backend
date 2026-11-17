-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "orders_status_enum" AS ENUM ('pending', 'paid', 'shipped', 'delivered', 'cancelled');

-- CreateEnum
CREATE TYPE "products_status_enum" AS ENUM ('active', 'draft', 'archived');

-- CreateEnum
CREATE TYPE "products_weight_unit_enum" AS ENUM ('kg', 'g', 'lb', 'oz');

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "sku" VARCHAR(64),
    "description" TEXT,
    "status" "products_status_enum" NOT NULL DEFAULT 'active',
    "imageUrl" VARCHAR(2048),
    "shopifyProductId" VARCHAR(64),
    "shopifyVariantId" VARCHAR(64),
    "shopifyInventoryItemId" VARCHAR(64),
    "shopifySyncedAt" TIMESTAMP(6),
    "productType" VARCHAR(255),
    "vendor" VARCHAR(255),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "price" DECIMAL(12,2) NOT NULL,
    "compareAtPrice" DECIMAL(12,2),
    "costPerItem" DECIMAL(12,2),
    "chargeTax" BOOLEAN NOT NULL DEFAULT true,
    "barcode" VARCHAR(255),
    "trackInventory" BOOLEAN NOT NULL DEFAULT true,
    "continueSellingWhenOutOfStock" BOOLEAN NOT NULL DEFAULT false,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "requiresShipping" BOOLEAN NOT NULL DEFAULT true,
    "weight" DECIMAL(10,3),
    "weightUnit" "products_weight_unit_enum" NOT NULL DEFAULT 'kg',
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "customerName" VARCHAR(200) NOT NULL,
    "customerEmail" VARCHAR(320) NOT NULL,
    "status" "orders_status_enum" NOT NULL DEFAULT 'pending',
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_shopifyProductId_key" ON "products"("shopifyProductId");

-- CreateIndex
CREATE UNIQUE INDEX "products_shopifyVariantId_key" ON "products"("shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "products_shopifyInventoryItemId_key" ON "products"("shopifyInventoryItemId");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
