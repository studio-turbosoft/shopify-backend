import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Same env files as the Nest app: .env.<NODE_ENV> first, then .env.
// loadEnvFile never overrides variables that are already set.
for (const file of [`.env.${process.env.NODE_ENV ?? 'development'}`, '.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
