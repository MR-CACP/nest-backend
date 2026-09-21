import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map, Observable } from 'rxjs';

import { type ApiResponse, ok } from '../utils/api-response';

/**
 * 全局响应拦截器：把控制器返回值包装为统一响应结构。
 * path 取自 request.path（不含 query，与 AllExceptionsFilter 一致），
 * 保证成功与失败响应携带相同字段（path/timestamp）。
 * 异常路径的响应结构由 AllExceptionsFilter 保证一致。
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T>> {
    const request = context.switchToHttp().getRequest<{ path?: string }>();
    const path = request.path ?? '/';
    return next.handle().pipe(map((data) => ok(data, path)));
  }
}
