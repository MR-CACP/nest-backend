import { registerAs } from '@nestjs/config';

import type {
  AppConfig,
  CorsConfig,
  DatabaseConfig,
  DbLoggingOption,
  JwtConfig,
  LogConfig,
  LogLevel,
  NodeEnv,
  RedisConfig,
  SwaggerConfig,
  ThrottlerConfig,
} from './types';

// 每个命名空间从已通过 env.validation.ts 校验的环境变量读取；
// 工厂保留必要默认值，NODE_ENV 等关键字段则显式校验（见 appConfig）

export const appConfig = registerAs('app', (): AppConfig => {
  // NODE_ENV 三层校验的最内层：main.ts fail-fast 与 env.validation.ts 的 Joi required
  // 之外，直接调用工厂（如单测、脚本）时也显式拒绝缺失或非法值，而非类型断言蒙混
  const rawEnv = process.env.NODE_ENV;
  if (
    rawEnv !== 'development' &&
    rawEnv !== 'production' &&
    rawEnv !== 'test'
  ) {
    throw new Error(
      `NODE_ENV 非法: ${String(rawEnv)}，必须是 development | production | test`,
    );
  }
  const env: NodeEnv = rawEnv;
  // 缺省不信任代理（安全默认）：直连部署下信任 X-Forwarded-For 会让客户端伪造
  // 真实 IP，绕过限流/污染日志；多层代理部署必须显式配置层数
  const rawTrustProxy = process.env.TRUST_PROXY ?? 'false';
  return {
    env,
    port: parseInt(process.env.PORT ?? '3000', 10),
    prefix: process.env.API_PREFIX ?? 'api',
    trustProxy:
      rawTrustProxy === 'false'
        ? false
        : rawTrustProxy === 'true'
          ? true
          : parseInt(rawTrustProxy, 10),
  };
});

export const corsConfig = registerAs('cors', (): CorsConfig => {
  // '*' 必须保留为字符串：拆成 ['*'] 会导致 cors 库匹配不到任何来源，
  // 跨域请求被浏览器拦截；多个来源用逗号分隔，如 https://a.com,https://b.com
  const raw = (process.env.CORS_ORIGIN ?? '*').trim();
  return {
    origins:
      raw === '*'
        ? '*'
        : raw
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean),
    credentials: (process.env.CORS_CREDENTIALS ?? 'false') === 'true',
  };
});

export const swaggerConfig = registerAs('swagger', (): SwaggerConfig => ({
  enabled: (process.env.SWAGGER_ENABLED ?? 'false') === 'true',
  path: process.env.SWAGGER_PATH ?? 'docs',
}));

export const throttlerConfig = registerAs('throttler', (): ThrottlerConfig => ({
  ttl: parseInt(process.env.THROTTLE_TTL ?? '60', 10),
  limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  storage: (process.env.THROTTLE_STORAGE ?? 'memory') as 'memory' | 'redis',
}));

export const logConfig = registerAs('log', (): LogConfig => ({
  level: (process.env.LOG_LEVEL ?? 'info') as LogLevel,
}));

export const jwtConfig = registerAs('jwt', (): JwtConfig => {
  // 开发缺省用显式标记的弱密钥（仅本地试跑）；生产缺失会直接启动失败（安全策略 7），
  // 不会把弱密钥静默带上线
  return {
    // 同步 trim：Joi 校验的 .trim() 只作用于校验副本、不回写 process.env，
    // 若这里读原始值，带首尾空白的密钥会"校验通过（trim 后）、签名用未 trim 值"，
    // 校验与运行时不同源——此处 trim 保证两侧严格一致（误带空白被自动修正）
    secret: process.env.JWT_SECRET?.trim() ?? 'dev-only-secret-change-me',
    accessTtlSeconds: parseInt(process.env.JWT_ACCESS_TTL_SECONDS ?? '900', 10),
    refreshTtlSeconds: parseInt(
      process.env.JWT_REFRESH_TTL_SECONDS ?? '604800',
      10,
    ),
  };
});

// ---------- 环境变量解析（不依赖 Nest 上下文，供 CLI/脚本复用） ----------

/**
 * env 文件加载优先级列表（先读到的变量优先生效）：
 * ConfigModule（app.module.ts）与 TypeORM CLI（data-source.ts）共用，
 * 禁止两处各自维护一份。
 */
export function getEnvFilePaths(nodeEnv: NodeEnv): string[] {
  return [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, '.env.local', '.env'];
}

/** DB_LOGGING：false 关闭 | true/all 全开 | 逗号分隔 TypeORM LogLevel 类别 */
export function parseDbLogging(raw: string | undefined): DbLoggingOption {
  if (!raw || raw === 'false') return false;
  if (raw === 'true' || raw === 'all') return 'all';
  const categories = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as Extract<DbLoggingOption, string[]>;
  return categories.length > 0 ? categories : false;
}

/**
 * 从 process.env 读取数据库配置（env.validation.ts 已保证取值合法，
 * 这里的默认值仅覆盖校验器之外的直接调用路径，如 TypeORM CLI）。
 * 与 databaseConfig 命名空间共用同一份实现，避免双真相源。
 */
export function buildDatabaseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  return {
    host: env.DB_HOST ?? 'localhost',
    port: parseInt(env.DB_PORT ?? '5432', 10),
    username: env.DB_USERNAME ?? 'app',
    password: env.DB_PASSWORD ?? '',
    database: env.DB_DATABASE ?? 'app_db',
    ssl: env.DB_SSL === 'true',
    // TLS 证书链校验默认开启；false 仅限本地/内网实验并显式配置（见 types.ts）
    sslRejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
    sslCa: env.DB_SSL_CA || undefined,
    synchronize: env.DB_SYNCHRONIZE === 'true',
    // 默认 'error' 与 Joi schema（env.validation.ts）保持一致：
    // 缺省时只记录失败查询，而不是完全关闭日志，避免 CLI/运行时两条路径产出漂移
    logging: parseDbLogging(env.DB_LOGGING ?? 'error'),
    pool: {
      max: parseInt(env.DB_POOL_MAX ?? '10', 10),
      min: parseInt(env.DB_POOL_MIN ?? '2', 10),
      idleTimeoutMs: parseInt(env.DB_POOL_IDLE_TIMEOUT_MS ?? '30000', 10),
      connectionTimeoutMs: parseInt(
        env.DB_POOL_CONNECTION_TIMEOUT_MS ?? '10000',
        10,
      ),
    },
    // 驱动级查询超时：statement_timeout（服务端主动终止，默认先触发）应小于
    // query_timeout（客户端兜底）——pg 的 query_timeout 到达时只本地回调失败，
    // 并不会取消服务端查询，若客户端先到则服务端仍会跑满 statement_timeout
    queryTimeoutMs: parseInt(env.DB_QUERY_TIMEOUT_MS ?? '5000', 10),
    statementTimeoutMs: parseInt(env.DB_STATEMENT_TIMEOUT_MS ?? '4000', 10),
  };
}

export function buildRedisConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RedisConfig {
  return {
    host: env.REDIS_HOST ?? 'localhost',
    port: parseInt(env.REDIS_PORT ?? '6379', 10),
    password: env.REDIS_PASSWORD ?? '',
    db: parseInt(env.REDIS_DB ?? '0', 10),
    keyPrefix: env.REDIS_KEY_PREFIX ?? 'app:',
    // 单条命令超时（ioredis commandTimeout），防依赖假死时命令无限挂起
    commandTimeoutMs: parseInt(env.REDIS_COMMAND_TIMEOUT_MS ?? '5000', 10),
  };
}

/** PostgreSQL 毫秒型 GUC 上界（int32 max）：超界值会被 PostgreSQL 以 out of range 拒绝 */
export const PG_MS_GUC_MAX = 2_147_483_647;

/**
 * 迁移专项锁等待超时（毫秒，0=禁用）：仅 TypeORM CLI（data-source.ts）使用，
 * 不经过 Joi 运行时校验（CLI 路径直接读原始 env）。迁移不设 statement/query 超时
 * （长 DDL 不应被中断，见 data-source.ts），但锁等待必须有限——否则迁移互相/
 * 自身死锁时会永久挂起，compose 的 migrate 服务永远到不了 completed。
 * 非法值回退默认 10000ms，保证部署不会因配置笔误直接失败。
 */
export function parseMigrationLockTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.DB_MIGRATION_LOCK_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 10_000;
  const parsed = Number(raw);
  // 安全整数 + PG 毫秒 GUC 上界（int32 max）：超大值会通过 Number.isInteger
  // 但被 PostgreSQL 以 out of range 拒绝，导致迁移连接失败
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= PG_MS_GUC_MAX
    ? parsed
    : 10_000;
}

export const databaseConfig = registerAs('database', () =>
  buildDatabaseConfigFromEnv(),
);

export const redisConfig = registerAs('redis', () => buildRedisConfigFromEnv());
