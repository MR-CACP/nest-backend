import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 请求关联 ID 的请求/响应头名称 */
export const REQUEST_ID_HEADER = 'x-request-id';

/** 复用传入 ID 的上限长度：防止客户端注入超长 header 造成日志/存储膨胀 */
const MAX_INCOMING_ID_LENGTH = 128;

/**
 * pino-http 的 genReqId 实现：复用合法传入的 X-Request-Id（与工单/网关链路
 * 关联），缺失或非法（空/超长）则生成 UUID；同时在响应头回写——
 * 保证用户拿到的关联 ID 能精确命中日志中的 req.id，支持排查时"ID → 日志"闭环。
 */
export function genRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const trimmed = typeof incoming === 'string' ? incoming.trim() : '';
  const id =
    trimmed.length > 0 && trimmed.length <= MAX_INCOMING_ID_LENGTH
      ? trimmed
      : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
