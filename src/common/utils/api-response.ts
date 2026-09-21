/** 统一响应结构：成功与失败共用同一形态，均携带请求路径与生成时间戳 */
export interface ApiResponse<T = unknown> {
  /** 业务码：0 表示成功，其余见 BusinessException 与 HTTP 状态码 */
  code: number;
  message: string;
  data: T;
  /** 请求路径（不含 query，避免搜索词/令牌等敏感信息外泄） */
  path: string;
  /** 响应生成时间 */
  timestamp: string;
}

/** 成功响应（TransformInterceptor 使用） */
export function ok<T>(data: T, path: string): ApiResponse<T> {
  return {
    code: 0,
    message: '成功',
    data,
    path,
    timestamp: new Date().toISOString(),
  };
}

/** 失败响应（AllExceptionsFilter 使用） */
export function fail(
  code: number,
  message: string,
  path: string,
): ApiResponse<null> {
  return {
    code,
    message,
    data: null,
    path,
    timestamp: new Date().toISOString(),
  };
}
