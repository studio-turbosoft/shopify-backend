import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { DevModule } from './dev/dev.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // NODE_ENV=production loads .env.production first; .env fills any gaps
      envFilePath: [`.env.${process.env.NODE_ENV ?? 'development'}`, '.env'],
    }),
    // Prisma connects lazily: the app boots without a database, and only
    // /api/products and /api/orders need DATABASE_URL to be reachable.
    PrismaModule,
    ProductsModule,
    OrdersModule,
    DevModule,
  ],
})
export class AppModule {}
