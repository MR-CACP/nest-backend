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
 * 异常路径的响应结构由 AllExceptionsFilter 保证一致。
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(map((data) => ok(data)));
  }
}
