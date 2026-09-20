import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { BusinessException } from '../exceptions/business.exception';
import { fail } from '../utils/api-response';
import { translateHttpMessage } from '../utils/error-messages';

/**
 * 全局异常过滤器：所有未捕获异常统一转换为统一响应结构，
 * 避免 stack trace 等内部信息直接暴露给客户端。
 * - BusinessException -> HTTP 200 + 业务 code
 * - HttpException（含框架抛出的 404/401/429 等）-> 真实 HTTP 状态码
 * - 未知异常 -> HTTP 500 + 固定文案，详细信息仅写入日志
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    // 非 HTTP 上下文（如将来接入 WebSocket/微服务）直接抛出，
    // 避免 response.status 等 HTTP API 引起过滤器内二次崩溃
    if (host.getType<string>() !== 'http') {
      throw exception;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status: number;
    let code: number;
    let message: string;

    if (exception instanceof BusinessException) {
      status = HttpStatus.OK;
      code = exception.bizCode;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status;
      // ValidationPipe 等返回的 message 可能是字符串数组，合并为一条
      const res = exception.getResponse();
      const resMessage =
        typeof res === 'string'
          ? res
          : ((res as Record<string, unknown>).message as
              string | string[] | undefined);
      message = Array.isArray(resMessage)
        ? resMessage.join('; ')
        : (resMessage ?? exception.message);
      // 框架级英文文案统一中文化
      message = translateHttpMessage(status, message);
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = status;
      message = '服务器内部错误，请稍后重试';
    }

    // 错误响应一律禁止缓存：业务异常(200)与错误页都可能被 CDN/代理缓存后放大故障
    response.setHeader('Cache-Control', 'no-store');

    // 5xx 结构化记录：消息与堆栈分开传给 pino（堆栈独立成字段，避免换行伪造日志，便于检索）
    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(fail(code, message, request.url));
  }
}
