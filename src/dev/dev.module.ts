import { Module } from '@nestjs/common';
import { HelloController } from './hello.controller';
import { TestRecordsController } from './test-records.controller';

/** Test routes that need no database: GET /api/hello and GET /api/test-records. */
@Module({
  controllers: [HelloController, TestRecordsController],
})
export class DevModule {}
