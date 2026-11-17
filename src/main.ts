import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: keeps the unparsed body on req.rawBody, needed to verify Shopify webhook HMACs.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Product webhooks carry every variant, which can exceed the default 100 kb.
  app.useBodyParser('json', { limit: '5mb' });
  app.setGlobalPrefix('api');
  // Health check at the root URL (outside the /api prefix): GET /
  app.getHttpAdapter().get('/', (_req: any, res: any) => {
    res.send('Server is running');
  });
  // CORS_ORIGIN may list several origins, comma-separated
  const origins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((o) => o.trim());
  app.enableCors({ origin: origins });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API listening on http://localhost:${port}/api`);
}
bootstrap();
