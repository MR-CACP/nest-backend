import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/** DataSource / RedisService 分别来自全局注册的 DatabaseModule 与 RedisModule */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
