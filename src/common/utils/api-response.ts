/** 统一响应结构：成功与失败共用同一形态，失败额外携带 path 与 timestamp */
export interface ApiResponse<T = unknown> {
  /** 业务码：0 表示成功，其余见 BusinessException 与 HTTP 状态码 */
  code: number;
  message: string;
  data: T;
}

/** 成功响应（TransformInterceptor 使用） */
export function ok<T>(data: T): ApiResponse<T> {
  return { code: 0, message: 'ok', data };
}

/** 失败响应（AllExceptionsFilter 使用），附带请求路径与时间戳便于定位 */
export function fail(
  code: number,
  message: string,
  path: string,
): ApiResponse<null> & { path: string; timestamp: string } {
  return {
    code,
    message,
    data: null,
    path,
    timestamp: new Date().toISOString(),
  };
}
