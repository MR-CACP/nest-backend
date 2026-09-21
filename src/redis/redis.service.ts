import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from './redis.constants';

/**
 * JSON 序列化的缓存门面：业务代码不直接接触 ioredis，
 * 统一键前缀由客户端 keyPrefix 承担。失败语义（详见各方法）：
 * - get/set/del/ttl：缓存侧故障（连接、序列化）一律记录后降级，不让业务请求 500；
 * - ping：透传真实状态，供健康检查判断依赖可用性；
 * - TTL 非法（≤0 或非整数）属编程错误，直接抛出，防止静默产生永不过期的键。
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  // 优雅停机：quit 等待在途命令；连接不可用时 quit 会挂起/报错，直接强制断开兜底
  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  /** 原生客户端：事务、pipeline、限速存储等需要直接操作的场景 */
  get nativeClient(): Redis {
    return this.client;
  }

  async get<T>(key: string): Promise<T | null> {
    let raw: string | null;
    try {
      raw = await this.client.get(key);
    } catch (err) {
      // 连接/命令故障：降级为未命中，不让业务请求 500
      this.logger.warn(`缓存读取失败，按未命中处理: key=${key} ${String(err)}`);
      return null;
    }
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      // 坏数据自愈：正常情况下 set 只写合法 JSON，解析失败说明键内容被外部污染
      // 或数据损坏——删除坏键，避免每次读取都重复命中并告警直到 TTL 过期；
      // 删除本身失败仅记录，不阻断本次降级
      this.logger.warn(
        `缓存 JSON 解析失败，删除坏键: key=${key} ${String(err)}`,
      );
      await this.client.del(key).catch((delErr: Error) => {
        this.logger.warn(`坏键删除失败: key=${key} ${String(delErr)}`);
      });
      return null;
    }
  }

  /** ttlSeconds 省略则永不过期（务必显式给过期时间，防止无界增长） */
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    // TTL 非法属编程错误：必须先于序列化校验（若先序列化，循环引用 + 非法 TTL
    // 会先被序列化分支吞掉，非法 TTL 反而不抛出，违背方法级契约）
    if (ttlSeconds !== undefined) {
      this.assertValidTtl(ttlSeconds);
    }
    let raw: string;
    try {
      raw = JSON.stringify(value);
    } catch (err) {
      // 循环引用/BigInt 等序列化失败：记录后跳过写入，不让业务请求 500
      this.logger.warn(`缓存序列化失败，跳过写入: key=${key} ${String(err)}`);
      return;
    }
    try {
      if (ttlSeconds !== undefined) {
        await this.client.setex(key, ttlSeconds, raw);
      } else {
        await this.client.set(key, raw);
      }
    } catch (err) {
      this.logger.warn(`缓存写入失败，跳过: key=${key} ${String(err)}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.client.del(...keys);
    } catch (err) {
      this.logger.warn(`缓存删除失败: keys=${keys.join(',')} ${String(err)}`);
    }
  }

  /** ttl：Redis 故障时视为无过期时间（-1），由调用方决定是否降级 */
  async ttl(key: string): Promise<number> {
    try {
      return await this.client.ttl(key);
    } catch (err) {
      this.logger.warn(`缓存 ttl 查询失败: key=${key} ${String(err)}`);
      return -1;
    }
  }

  async ping(): Promise<'PONG'> {
    return this.client.ping();
  }

  private assertValidTtl(ttlSeconds: number): void {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError(
        `ttlSeconds 必须是正整数秒（0/负数/小数会产生非预期过期行为），收到: ${ttlSeconds}`,
      );
    }
  }
}
