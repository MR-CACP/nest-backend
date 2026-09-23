import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';

/** supertest 响应体统一收敛到该形态（与 TransformInterceptor/AllExceptionsFilter 对齐） */
type Body = {
  code: number;
  message: string;
  data: Record<string, unknown> & { id?: string };
};

/**
 * 数据层相关 e2e：依赖 docker-compose.yml 起的 PostgreSQL + Redis。
 * 当前 schema 由 DB_SYNCHRONIZE=true 自动同步；引入迁移后建议改回 false
 * 并先执行 pnpm run migration:run:test。
 */
describe('数据层 (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/health', () => {
    it('依赖可用时返回 200 且只暴露整体状态', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/health')
        .expect(200);
      const body = res.body as Body;
      expect(body).toMatchObject({
        code: 0,
        data: { status: 'ok' },
      });
      // 契约断言：健康响应不携带组件级字段
      expect(body.data).not.toHaveProperty('db');
      expect(body.data).not.toHaveProperty('cache');
    });
  });
});
