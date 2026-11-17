import { Module } from '@nestjs/common';
import { HelloController } from './hello.controller';

/** Health check that needs no database: GET /api/hello. */
@Module({
  controllers: [HelloController],
})
export class DevModule {}
