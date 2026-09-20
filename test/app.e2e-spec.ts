import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';

describe('AppController (e2e)', () => {
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

  it('/api (GET) 返回统一响应结构', () => {
    return request(app.getHttpServer())
      .get('/api')
      .expect(200)
      .then((res) => {
        expect(res.body).toMatchObject({
          code: 0,
          message: 'ok',
          data: 'Hello World!',
        });
      });
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

  it('演示路由默认关闭（DEMO_ROUTES_ENABLED=false）', () => {
    return request(app.getHttpServer())
      .get('/api/error')
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
});
