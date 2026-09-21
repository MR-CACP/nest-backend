import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { TransformInterceptor } from '../../../src/common/interceptors/transform.interceptor';

describe('TransformInterceptor', () => {
  it('把控制器返回值包装为统一响应结构（含 path/timestamp）', async () => {
    const interceptor = new TransformInterceptor<{ hello: string }>();
    const context = {
      switchToHttp: () => ({
        getResponse: () => ({}),
        getRequest: () => ({ path: '/api/hello' }),
      }),
    } as unknown as ExecutionContext;
    const handler = {
      handle: () => of({ hello: 'world' }),
    } as unknown as CallHandler<{ hello: string }>;

    const result = await firstValueFrom(
      interceptor.intercept(context, handler),
    );
    expect(result).toMatchObject({
      code: 0,
      message: '成功',
      data: { hello: 'world' },
      path: '/api/hello',
    });
    expect(result.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('请求对象缺失 path 时回退 /', async () => {
    const interceptor = new TransformInterceptor<unknown>();
    const context = {
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;
    const handler = {
      handle: () => of(null),
    } as unknown as CallHandler<unknown>;

    const result = await firstValueFrom(
      interceptor.intercept(context, handler),
    );
    expect(result.path).toBe('/');
  });
});
