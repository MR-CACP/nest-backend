import { ServiceUnavailableException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { HealthController } from '../../src/health/health.controller';
import type { RedisService } from '../../src/redis/redis.service';

describe('HealthController', () => {
  const makeController = (
    db: Promise<unknown>,
    cache: Promise<unknown>,
  ): HealthController =>
    new HealthController(
      {
        query: jest.fn().mockImplementation(() => db),
      } as unknown as DataSource,
      {
        ping: jest.fn().mockImplementation(() => cache),
      } as unknown as RedisService,
    );

  describe('live（进程存活，不探测依赖）', () => {
    it('即使依赖全挂也返回 ok', () => {
      // live() 从不消费依赖 promise：用永挂起而非 rejected promise，
      // 否则立即构造的 rejection 无人处理会触发 unhandled rejection 崩溃测试进程
      const pending = new Promise<never>(() => {});
      const controller = makeController(pending, pending);
      expect(controller.live()).toEqual({ status: 'ok' });
      expect(controller).toBeDefined();
    });
  });

  describe('ready / check（依赖就绪）', () => {
    it('数据库与 Redis 均可用时返回 ok', async () => {
      const controller = makeController(
        Promise.resolve([{ '?column?': 1 }]),
        Promise.resolve('PONG'),
      );
      await expect(controller.ready()).resolves.toEqual({ status: 'ok' });
    });

    it.each([
      [
        '数据库故障',
        Promise.reject(new Error('db down')),
        Promise.resolve('PONG'),
      ],
      [
        'Redis 故障',
        Promise.resolve([]),
        Promise.reject(new Error('ECONNREFUSED')),
      ],
      [
        '双依赖故障',
        Promise.reject(new Error('a')),
        Promise.reject(new Error('b')),
      ],
    ])('%s 时返回 503 且响应体不泄漏组件级细节', async (_name, db, cache) => {
      const controller = makeController(db, cache);
      await expect(controller.ready()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await controller.ready().catch((err: ServiceUnavailableException) => {
        const body = err.getResponse() as Record<string, unknown>;
        expect(body).toEqual({ status: 'degraded' });
        // 关键断言：不得出现 db/cache 组件状态
        expect(body).not.toHaveProperty('db');
        expect(body).not.toHaveProperty('cache');
      });
    });

    it('/health 别名与 ready 语义一致', async () => {
      const controller = makeController(
        Promise.resolve([{ '?column?': 1 }]),
        Promise.resolve('PONG'),
      );
      await expect(controller.check()).resolves.toEqual({ status: 'ok' });
    });

    it('依赖挂起超过 2s 按降级处理（探针不被拖死）', async () => {
      jest.useFakeTimers();
      try {
        const controller = makeController(
          new Promise(() => {
            // 永不 resolve/reject：模拟依赖假死
          }),
          Promise.resolve('PONG'),
        );
        const result = controller.ready();
        jest.advanceTimersByTime(2000);
        await expect(result).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
