import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { DataSource } from 'typeorm';

import { RedisService } from '../redis/redis.service';

/** 单个依赖检查的超时上限（毫秒）：探针调用方（容器 HEALTHCHECK / 编排器）
 * 通常自带超时与间隔，这里必须在它们之内快速失败，否则依赖假死会把探针拖死 */
const DEPENDENCY_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  // 用显式 Promise 而非 Promise.race：settle 后必须 clearTimeout，
  // 否则探针已返回后定时器仍在挂起（e2e 会报 active timers 泄漏，生产里堆积无意义）
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`${label} 检查超时（${DEPENDENCY_TIMEOUT_MS}ms）`)),
      DEPENDENCY_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * 健康检查三类语义，探针用途不可混用：
 * - /health/live：进程存活（不探测依赖），供容器 HEALTHCHECK 判活——
 *   依赖故障不应触发应用重启，应留给编排器/负载均衡做流量摘除；
 * - /health/ready：依赖就绪（数据库 SELECT 1 + Redis PING，各带短超时），
 *   供负载均衡/发布流程判断是否可以接流量；
 * - /health：兼容别名，语义与 ready 一致（历史契约，勿依赖新增端点）。
 * 响应体只回整体状态（ok / degraded），失败详情只写日志——
 * 组件级状态留给匿名调用方会成为探测攻击的地图。
 */
@Controller('health')
@SkipThrottle({ default: true })
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async ready(): Promise<{ status: 'ok' }> {
    return this.checkDependencies();
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async check(): Promise<{ status: 'ok' }> {
    return this.checkDependencies();
  }

  private async checkDependencies(): Promise<{ status: 'ok' }> {
    const [db, cache] = await Promise.allSettled([
      withTimeout(this.dataSource.query('SELECT 1'), '数据库'),
      withTimeout(this.redis.ping(), 'Redis'),
    ]);
    if (db.status === 'rejected' || cache.status === 'rejected') {
      const detail = {
        db: db.status === 'fulfilled' ? 'up' : 'down',
        cache: cache.status === 'fulfilled' ? 'up' : 'down',
      };
      this.logger.error(
        `健康检查降级: ${JSON.stringify(detail)}; ` +
          `${db.status === 'rejected' ? String(db.reason) : ''} ` +
          `${cache.status === 'rejected' ? String(cache.reason) : ''}`,
      );
      throw new ServiceUnavailableException({ status: 'degraded' });
    }
    return { status: 'ok' };
  }
}
