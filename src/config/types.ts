export type NodeEnv = 'development' | 'production' | 'test';

export type LogLevel =
  'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppConfig {
  env: NodeEnv;
  port: number;
  prefix: string;
  /** 反向代理可信层数：数字=可信层数，false=不信任（无代理直连），true=全部信任 */
  trustProxy: number | boolean;
  /** 演示/调试路由（/api/error、/api/echo）显式开关，默认关闭，不依赖 NODE_ENV 推断 */
  demoRoutesEnabled: boolean;
}

export interface CorsConfig {
  /** 允许的来源；'*' 表示任意来源（保留字符串语义，交给 cors 库处理） */
  origins: string | string[];
  credentials: boolean;
}

export interface SwaggerConfig {
  enabled: boolean;
  path: string;
}

export interface ThrottlerConfig {
  /** 限速时间窗口（秒），@nestjs/throttler 内部使用毫秒 */
  ttl: number;
  /** 时间窗口内允许的最大请求数 */
  limit: number;
}

export interface LogConfig {
  level: LogLevel;
}
