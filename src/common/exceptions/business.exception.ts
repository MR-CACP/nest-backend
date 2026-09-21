import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 业务异常：表示业务规则不满足（如"库存不足"）。
 * 显式版本化契约（勿改）：HTTP 状态保持 200，失败语义通过响应体 bizCode 传递，
 * 这是国内业务码惯例；代理/重试/指标会按状态码把业务失败当成功，可观测性已由
 * AllExceptionsFilter 补偿（X-Business-Code 响应头 + warn 级日志 + Cache-Control: no-store）。
 * 若未来需要严格 REST 语义，应改为 4xx/409 并把 bizCode 保留在响应体——属破坏性变更需升版本。
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
