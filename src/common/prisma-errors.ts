import { Prisma } from '../generated/prisma/client';

/** Prisma error codes: https://www.prisma.io/docs/orm/reference/error-reference */
export const UNIQUE_VIOLATION = 'P2002';
export const FK_VIOLATION = 'P2003';
export const RECORD_NOT_FOUND = 'P2025';

export function isPrismaError(e: unknown, code: string): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === code;
}

/** Postgres NUMERIC comes back as Prisma.Decimal; the API exposes plain numbers. */
export const toNumber = (d: Prisma.Decimal | number) => Number(d);
