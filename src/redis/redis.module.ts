import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';

import type { RedisConfig } from '../config/types';
import { REDIS_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

/**
 * ioredis 客户端选项构建：抽成纯函数便于单测。
 * commandTimeout 语义：0=禁用（类型注释与 Joi schema 约定），但 ioredis 对 0 会执行
 * setTimeout(..., 0) 导致每条命令立即超时，因此仅在大于 0 时传入该选项。
 */
export function buildRedisClientOptions(cfg: RedisConfig): RedisOptions {
  return {
    host: cfg.host,
    port: cfg.port,
    // 空串按“无鉴权”处理（ioredis 会把空密码当作 AUTH 参数发送）
    password: cfg.password || undefined,
    db: cfg.db,
    keyPrefix: cfg.keyPrefix,
    // 单条命令在积压超过 2 次重连后直接失败，避免 Redis 宕机时请求无限挂起
    maxRetriesPerRequest: 2,
    // 单条命令超时：依赖假死时命令在超时后报错返回（与健康检查的 2s 探针超时分层兜底）；
    // 0=禁用（不传该选项），由 ioredis 默认行为决定（不会主动超时）
    ...(cfg.commandTimeoutMs > 0
      ? { commandTimeout: cfg.commandTimeoutMs }
      : {}),
    // 指数退避重连：500ms 起步倍增，封顶 10s，防止故障时高频冲击
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  };
}

/**
 * Redis 全局模块：缓存层与限速存储共用同一个 ioredis 客户端
 * （ioredis 单连接即多路复用，无连接池必要；需要事务/Cluster 时再扩）。
 * 连接失败不阻断启动：ioredis 后台按 retryStrategy 重连，
 * 依赖 Redis 的功能（缓存、Redis 限速存储）在此期间降级报错。
 *
 * 设计取舍：客户端总是创建（即使 THROTTLE_STORAGE=memory 不用于限速存储），
 * 且 /api/health 会 ping Redis 并计入整体状态——即"Redis 是模板必需依赖"。
 * 若未来要支持无 Redis 部署，需改为懒创建客户端 + 健康检查按组件降级（见 CODE_REVIEW P2-6）。
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis => {
        // 运行时命名空间必须存在（ConfigModule load 已注册）；缺失即抛错，不静默回退
        const cfg = configService.getOrThrow<RedisConfig>('redis');
        const logger = new Logger('Redis');
        const client = new Redis(buildRedisClientOptions(cfg));
        client.on('ready', () => logger.log(`就绪 ${cfg.host}:${cfg.port}`));
        client.on('error', (err: Error) =>
          logger.error(`连接异常: ${err.message}`),
        );
        return client;
      },
    },
    RedisService,
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
