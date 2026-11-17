import { Prisma } from '../generated/prisma/client';

/** Postgres NUMERIC comes back as Prisma.Decimal; the API exposes plain numbers. */
export const toNumber = (d: Prisma.Decimal | number) => Number(d);

/** Same as toNumber, but keeps null (for optional columns). */
export const toNumberOrNull = (d: Prisma.Decimal | number | null) => (d === null ? null : Number(d));
