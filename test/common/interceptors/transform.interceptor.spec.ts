import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { TransformInterceptor } from '../../../src/common/interceptors/transform.interceptor';

describe('TransformInterceptor', () => {
  it('把控制器返回值包装为统一响应结构', async () => {
    const interceptor = new TransformInterceptor<{ hello: string }>();
    const context = {
      switchToHttp: () => ({ getResponse: () => ({}), getRequest: () => ({}) }),
    } as unknown as ExecutionContext;
    const handler = {
      handle: () => of({ hello: 'world' }),
    } as unknown as CallHandler<{ hello: string }>;

    const result = await firstValueFrom(
      interceptor.intercept(context, handler),
    );
    expect(result).toEqual({
      code: 0,
      message: 'ok',
      data: { hello: 'world' },
    });
  });
});
