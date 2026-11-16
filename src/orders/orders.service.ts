import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toNumber } from '../common/prisma-errors';
import { toProductDto } from '../products/products.service';
import { CreateOrderDto, OrderItemDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';

type Tx = Prisma.TransactionClient;

const withItems = { items: { include: { product: true }, orderBy: { id: 'asc' } } } as const;
type OrderWithItems = Prisma.OrderGetPayload<{ include: typeof withItems }>;

/** API shape: numbers instead of Prisma.Decimal; items carry their product. */
const toOrderDto = (o: OrderWithItems) => ({
  ...o,
  total: toNumber(o.total),
  items: o.items.map(({ orderId, ...i }) => ({
    ...i,
    unitPrice: toNumber(i.unitPrice),
    product: toProductDto(i.product),
  })),
});

type NewItem = { productId: number; quantity: number; unitPrice: Prisma.Decimal };

/**
 * Stock rule: an order holds stock for its items unless it is cancelled.
 * Every write runs in a transaction that releases the old hold and applies the new one,
 * with product rows locked (SELECT ... FOR UPDATE) so concurrent orders cannot oversell.
 */
@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const orders = await this.prisma.order.findMany({ orderBy: { id: 'desc' }, include: withItems });
    return orders.map(toOrderDto);
  }

  async findOne(id: number) {
    return toOrderDto(await this.load(this.prisma, id));
  }

  async create(dto: CreateOrderDto) {
    const order = await this.prisma.$transaction(async (tx) => {
      const status = dto.status ?? OrderStatus.pending;
      const items = await this.buildItems(tx, dto.items, status !== OrderStatus.cancelled);
      const created = await tx.order.create({
        data: {
          customerName: dto.customerName,
          customerEmail: dto.customerEmail,
          status,
          total: this.sum(items),
          items: { create: items },
        },
      });
      return this.load(tx, created.id);
    });
    return toOrderDto(order);
  }

  async update(id: number, dto: UpdateOrderDto) {
    const order = await this.prisma.$transaction(async (tx) => {
      const order = await this.load(tx, id);
      const newStatus = dto.status ?? order.status;
      const wasHolding = order.status !== OrderStatus.cancelled;
      const willHold = newStatus !== OrderStatus.cancelled;

      const data: Prisma.OrderUpdateInput = { status: newStatus };
      if (dto.customerName !== undefined) data.customerName = dto.customerName;
      if (dto.customerEmail !== undefined) data.customerEmail = dto.customerEmail;

      if (dto.items !== undefined || wasHolding !== willHold) {
        if (wasHolding) await this.releaseStock(tx, order.items);
        const wanted =
          dto.items ?? order.items.map((i) => ({ productId: i.productId, quantity: i.quantity }));
        const items = await this.buildItems(tx, wanted, willHold, order.items);
        data.total = this.sum(items);
        data.items = { deleteMany: {}, create: items };
      }

      await tx.order.update({ where: { id }, data });
      return this.load(tx, id);
    });
    return toOrderDto(order);
  }

  async remove(id: number) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.load(tx, id);
      if (order.status !== OrderStatus.cancelled) await this.releaseStock(tx, order.items);
      await tx.order.delete({ where: { id } }); // items are removed by ON DELETE CASCADE
    });
  }

  private async load(db: Tx, id: number) {
    const order = await db.order.findUnique({ where: { id }, include: withItems });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return order;
  }

  private sum(items: NewItem[]) {
    const total = items.reduce((t, i) => t.add(i.unitPrice.mul(i.quantity)), new Prisma.Decimal(0));
    return total.toDecimalPlaces(2);
  }

  /**
   * Turn requested lines into order items (duplicate product lines are merged).
   * Products already on the order keep their captured unit price; new lines take the
   * current product price.
   */
  private async buildItems(
    tx: Tx,
    lines: OrderItemDto[],
    reserve: boolean,
    previous: { productId: number; unitPrice: Prisma.Decimal }[] = [],
  ): Promise<NewItem[]> {
    const merged = new Map<number, number>();
    for (const l of lines) merged.set(l.productId, (merged.get(l.productId) ?? 0) + l.quantity);
    const ids = [...merged.keys()];

    // Lock the product rows for the rest of the transaction.
    await tx.$queryRaw`SELECT id FROM products WHERE id = ANY(${ids}::int[]) ORDER BY id FOR UPDATE`;
    const products = await tx.product.findMany({ where: { id: { in: ids } } });

    const byId = new Map(products.map((p) => [p.id, p]));
    const missing = ids.filter((pid) => !byId.has(pid));
    if (missing.length) throw new BadRequestException(`Unknown product id(s): ${missing.join(', ')}`);

    const prevPrice = new Map(previous.map((i) => [i.productId, i.unitPrice]));
    const items: NewItem[] = [];
    for (const [productId, quantity] of merged) {
      const product = byId.get(productId)!;
      if (reserve) {
        if (product.stock < quantity) {
          throw new BadRequestException(
            `Not enough stock for "${product.name}" (requested ${quantity}, available ${product.stock})`,
          );
        }
        await tx.product.update({ where: { id: productId }, data: { stock: { decrement: quantity } } });
      }
      items.push({ productId, quantity, unitPrice: prevPrice.get(productId) ?? product.price });
    }
    return items;
  }

  private async releaseStock(tx: Tx, items: { productId: number; quantity: number }[]) {
    for (const item of items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { increment: item.quantity } },
      });
    }
  }
}
