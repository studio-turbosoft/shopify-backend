import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Prisma client shared across the app.
 * It connects on the first query (not at startup), so the server still boots
 * when the database is unreachable; only DB-backed routes fail.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    super({ adapter: new PrismaPg({ connectionString: config.get<string>('DATABASE_URL') }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
