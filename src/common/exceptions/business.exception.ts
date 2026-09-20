import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 业务异常：表示业务规则不满足（如"库存不足"）。
 * HTTP 状态保持 200，错误语义通过响应体中的业务 code 传递，
 * 由全局异常过滤器（AllExceptionsFilter）统一转换为响应结构。
 *
 * @example throw new BusinessException('库存不足');        // code 默认 40000
 * @example throw new BusinessException('用户不存在', 10001);
 */
export class BusinessException extends HttpException {
  constructor(
    message: string,
    readonly bizCode = 40000,
  ) {
    super(message, HttpStatus.OK);
  }
}
