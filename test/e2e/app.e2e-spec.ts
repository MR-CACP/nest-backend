import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';

describe('应用装配 (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // 装配逻辑与 main.ts 完全一致（helmet/管道/前缀/CORS/Swagger），保证测试应用等价
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('未知接口返回 404 与中文文案', () => {
    return request(app.getHttpServer())
      .get('/api/notexist')
      .expect(404)
      .then((res) => {
        const body = res.body as { message?: string };
        expect(body.message).toBe('接口不存在');
      });
  });

  it('错误响应携带 Cache-Control: no-store', () => {
    return request(app.getHttpServer())
      .get('/api/notexist')
      .expect(404)
      .then((res) => {
        const headers = res.headers as Record<string, string>;
        expect(headers['cache-control']).toBe('no-store');
      });
  });

  it('客户端携带 X-Request-Id 时透传回写', () => {
    return request(app.getHttpServer())
      .get('/api/notexist')
      .set('X-Request-Id', 'trace-abc-123')
      .expect(404)
      .then((res) => {
        const headers = res.headers as Record<string, string>;
        expect(headers['x-request-id']).toBe('trace-abc-123');
      });
  });

  it('缺失 X-Request-Id 时生成 UUID 回写', () => {
    return request(app.getHttpServer())
      .get('/api/notexist')
      .expect(404)
      .then((res) => {
        const headers = res.headers as Record<string, string>;
        expect(headers['x-request-id']).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      });
  });
});
