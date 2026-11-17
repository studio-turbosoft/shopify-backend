import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
} from 'class-validator';
import { blankToNull, cleanTags } from '../../common/transforms';
import { ProductStatus, WeightUnit } from '../../generated/prisma/client';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  /** Optional, like Shopify. Blank is stored as null. */
  @IsOptional()
  @Transform(blankToNull)
  @IsString()
  @MaxLength(64)
  sku?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  imageUrl?: string | null;

  // Organization

  @IsOptional()
  @IsString()
  @MaxLength(255)
  productType?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  vendor?: string | null;

  @IsOptional()
  @Transform(cleanTags)
  @IsArray()
  @ArrayMaxSize(250)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  tags?: string[];

  // Pricing

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  compareAtPrice?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costPerItem?: number | null;

  @IsOptional()
  @IsBoolean()
  chargeTax?: boolean;

  // Inventory

  @IsOptional()
  @IsString()
  @MaxLength(255)
  barcode?: string | null;

  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @IsOptional()
  @IsBoolean()
  continueSellingWhenOutOfStock?: boolean;

  @IsInt()
  @Min(0)
  stock: number;

  // Shipping

  @IsOptional()
  @IsBoolean()
  requiresShipping?: boolean;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  weight?: number | null;

  @IsOptional()
  @IsEnum(WeightUnit)
  weightUnit?: WeightUnit;
}
