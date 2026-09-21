import type { LoggerOptions } from 'typeorm';

/** 运行环境三态；NODE_ENV 必须由进程环境注入（见 app.module.ts） */
export type NodeEnv = 'development' | 'production' | 'test';

/** TypeORM 查询日志选项：false 关闭 / 'all' 全开 / 按级别数组（query,schema,error,...） */
export type DbLoggingOption = LoggerOptions;

/** pino 日志级别（从低到高），对应 LOG_LEVEL 环境变量 */
export type LogLevel =
  'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** 应用基础配置（app 命名空间） */
export interface AppConfig {
  env: NodeEnv;
  port: number;
  prefix: string;
  /** 反向代理可信层数：数字=可信层数，false=不信任（无代理直连），true=全部信任 */
  trustProxy: number | boolean;
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
  /** 计数存储：memory 单进程内存（多副本时限额×副本数）；redis 跨实例共享计数 */
  storage: 'memory' | 'redis';
}

export interface LogConfig {
  level: LogLevel;
}

/** JWT 认证配置（jwt 命名空间） */
export interface JwtConfig {
  /** 签名密钥；开发缺省用兜底弱密钥（仅本地），生产必须显式配置（安全策略 7） */
  secret: string;
  /** 访问令牌有效期（秒，默认 15 分钟）：无状态不存库，TTL 短以缩小泄露窗口 */
  accessTtlSeconds: number;
  /** 刷新令牌有效期（秒，默认 7 天）：DB 存哈希，撤销/过期即失效 */
  refreshTtlSeconds: number;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /** 是否以 TLS 连接 PostgreSQL（托管数据库常要求） */
  ssl: boolean;
  /** TLS 是否校验证书链（默认 true）。仅本地/内网实验允许显式设 false；
   *  指向外部托管数据库时必须保持 true 并配置 sslCa，否则等于接受任意证书（MITM） */
  sslRejectUnauthorized: boolean;
  /** CA 证书文件路径（PEM）。提供时强制 rejectUnauthorized=true 并校验服务端证书链 */
  sslCa?: string;
  /** schema 同步（仅原型/测试用；生产必须 false，schema 变更走 migration） */
  synchronize: boolean;
  logging: DbLoggingOption;
  /** 连接池参数，映射到 node-postgres 的 pool 选项 */
  pool: {
    max: number;
    min: number;
    /** 空闲连接回收时间（毫秒） */
    idleTimeoutMs: number;
    /** 获取连接的等待超时（毫秒） */
    connectionTimeoutMs: number;
  };
  /** 客户端查询超时（毫秒，0=禁用）：兜底中止在途查询（pg 到达后仅本地回调失败，不取消服务端查询） */
  queryTimeoutMs: number;
  /** 服务端语句超时（毫秒，0=禁用）：由 PostgreSQL 主动终止，应先于 queryTimeoutMs 触发 */
  statementTimeoutMs: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  /** 空串表示无鉴权（仅限本地开发） */
  password: string;
  /** 逻辑库编号 0-15 */
  db: number;
  /** 所有键的统一前缀，隔离同实例多应用 */
  keyPrefix: string;
  /** 单条命令超时（毫秒，0=禁用）：命令长时间不返回即报错，防依赖假死挂起调用方 */
  commandTimeoutMs: number;
}
