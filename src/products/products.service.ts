import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Product } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toNumber, toNumberOrNull } from '../common/decimal';
import { FK_VIOLATION, isPrismaError, RECORD_NOT_FOUND, UNIQUE_VIOLATION } from '../common/prisma-errors';
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

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const products = await this.prisma.product.findMany({ orderBy: { id: 'desc' } });
    return products.map(toProductDto);
  }

  async findOne(id: number) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return toProductDto(product);
  }

  async create(dto: CreateProductDto) {
    try {
      return toProductDto(await this.prisma.product.create({ data: dto }));
    } catch (e) {
      throw this.mapWriteError(e, dto.sku);
    }
  }

  async update(id: number, dto: UpdateProductDto) {
    try {
      return toProductDto(await this.prisma.product.update({ where: { id }, data: dto }));
    } catch (e) {
      throw this.mapWriteError(e, dto.sku, id);
    }
  }

  async remove(id: number) {
    try {
      await this.prisma.product.delete({ where: { id } });
    } catch (e) {
      if (isPrismaError(e, FK_VIOLATION)) {
        throw new ConflictException('Product is used in existing orders and cannot be deleted');
      }
      throw this.mapWriteError(e, undefined, id);
    }
  }

  private mapWriteError(e: unknown, sku?: string | null, id?: number) {
    if (isPrismaError(e, UNIQUE_VIOLATION)) return new ConflictException(`SKU "${sku}" already exists`);
    if (isPrismaError(e, RECORD_NOT_FOUND)) return new NotFoundException(`Product ${id} not found`);
    return e;
  }
}
