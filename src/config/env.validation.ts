import Joi from 'joi';

import { PG_MS_GUC_MAX } from './configuration';

/**
 * 环境变量校验：ConfigModule 加载完 env 文件后对 process.env 执行，
 * 任何缺失或非法的变量都会让应用启动失败（fail fast）。
 */
export const envValidationSchema = Joi.object({
  // NODE_ENV 必填（纵深防御）：不变量不只靠 main.ts 单点保证，
  // 绕过 main 的入口（worker/cron/脚本）缺值时同样启动失败，而不是 fail-open 到 development。
  // main.ts fail-fast + jest 自动设 test + start 脚本 cross-env，链路上 .required() 是安全的
  NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),

  PORT: Joi.number().port().default(3000),

  // 反向代理可信层数，取值语义见 types.ts 的 AppConfig.trustProxy。
  // 故意不设默认值：生产环境强制显式配置（见 custom），
  // 防止直连部署默认信任代理导致 X-Forwarded-For 伪造绕过限流。
  // 数字跳数限 0-10（`true` 信任所有仍保留给特殊网络）：
  // 无界跳数会让任意层数的伪造 X-Forwarded-For 都生效，污染限流维度与审计 IP
  TRUST_PROXY: Joi.string().pattern(/^(true|false|0|[1-9]|10)$/),

  API_PREFIX: Joi.string().trim().min(1).default('api'),

  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  SWAGGER_PATH: Joi.string().trim().min(1).default('docs'),

  THROTTLE_TTL: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),

  // 故意不设默认值：开发/测试环境缺省时由 corsConfig 工厂兜底 '*'；
  // 生产环境强制显式配置（见 custom 安全策略 6），不允许默认通配 * 静默上线
  CORS_ORIGIN: Joi.string().trim().min(1),
  CORS_CREDENTIALS: Joi.string().valid('true', 'false').default('false'),

  // 限速计数存储：redis 需 Redis 可用（生产多副本部署必须 redis，否则限额=limit×副本数）
  THROTTLE_STORAGE: Joi.string().valid('memory', 'redis').default('memory'),

  // ---------- PostgreSQL / TypeORM ----------
  DB_HOST: Joi.string().trim().min(1).default('localhost'),
  DB_PORT: Joi.number().port().default(5432),
  DB_USERNAME: Joi.string().trim().min(1).default('app'),
  // 默认空串仅方便本地无库试跑；生产规则在下面 custom 中强制非空
  DB_PASSWORD: Joi.string().trim().allow('').default(''),
  DB_DATABASE: Joi.string()
    .trim()
    .pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .default('app_db'),
  DB_SSL: Joi.string().valid('true', 'false').default('false'),
  // 校验证书链默认开启：外部托管数据库必须校验；false 仅限本地/内网实验并显式配置
  DB_SSL_REJECT_UNAUTHORIZED: Joi.string()
    .valid('true', 'false')
    .default('true'),
  // CA 证书文件路径（PEM），提供时强制 rejectUnauthorized=true 并校验服务端证书链
  DB_SSL_CA: Joi.string().trim().min(1).optional(),
  // schema 同步只允许出现在开发原型；生产强制 false（见 custom），正式变更走 migration
  DB_SYNCHRONIZE: Joi.string().valid('true', 'false').default('false'),
  // SQL 日志：false | true/all | 逗号分隔 TypeORM LogLevel（query,schema,error,warn,info,log,migration）
  DB_LOGGING: Joi.string()
    .trim()
    .pattern(
      /^(true|false|all|query|schema|error|warn|info|log|migration)(,(query|schema|error|warn|info|log|migration))*$/,
    )
    .default('error'),
  DB_POOL_MAX: Joi.number().integer().min(1).default(10),
  DB_POOL_MIN: Joi.number().integer().min(0).default(2),
  DB_POOL_IDLE_TIMEOUT_MS: Joi.number().integer().min(1000).default(30000),
  DB_POOL_CONNECTION_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .default(10000),
  // 驱动级查询超时：服务端先终止（statement_timeout，默认先触发），客户端兜底
  // （query_timeout）——pg 的 query_timeout 只本地回调失败、不取消服务端查询；0=禁用。
  // max 为 PG 毫秒型 GUC 上界（int32 max），超界值会被 PostgreSQL 以 out of range 拒绝
  DB_QUERY_TIMEOUT_MS: Joi.number()
    .integer()
    .min(0)
    .max(PG_MS_GUC_MAX)
    .default(5000),
  DB_STATEMENT_TIMEOUT_MS: Joi.number()
    .integer()
    .min(0)
    .max(PG_MS_GUC_MAX)
    .default(4000),

  // ---------- Redis ----------
  REDIS_HOST: Joi.string().trim().min(1).default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  // 空串表示无鉴权，仅适合本机容器；生产强制非空（见 custom）
  REDIS_PASSWORD: Joi.string().trim().allow('').default(''),
  REDIS_DB: Joi.number().integer().min(0).max(15).default(0),
  REDIS_KEY_PREFIX: Joi.string()
    .trim()
    .pattern(/^[\w.-]*:$/)
    .default('app:'),
  // 单条命令超时（毫秒，0=禁用），防依赖假死时命令无限挂起；
  // max 为 setTimeout 允许的毫秒上界（int32 max），超界会被 ioredis 告警/异常
  REDIS_COMMAND_TIMEOUT_MS: Joi.number()
    .integer()
    .min(0)
    .max(PG_MS_GUC_MAX)
    .default(5000),

  // ---------- JWT（认证模块） ----------
  // 签名密钥：故意不设默认值——开发环境由 jwtConfig 工厂兜底弱密钥（仅本地），
  // 生产强制显式配置（见 custom 安全策略 7），防止弱密钥静默上线
  JWT_SECRET: Joi.string().trim().min(16),
  JWT_ACCESS_TTL_SECONDS: Joi.number().integer().min(60).default(900),
  JWT_REFRESH_TTL_SECONDS: Joi.number().integer().min(60).default(604800),
})
  .unknown(true)
  // joi 18 的 when 不支持在条件里引用同级 key，跨字段规则需用 custom 实现
  .custom((value: Record<string, unknown>, helpers) => {
    // 安全策略 1：生产环境强制禁止 Swagger，防止误配置暴露接口文档
    if (value.NODE_ENV === 'production' && value.SWAGGER_ENABLED !== 'false') {
      return helpers.error('swagger.prod');
    }
    // 安全策略 2：credentials=true + origin=* 是浏览器明确拒绝的组合
    if (value.CORS_CREDENTIALS === 'true' && value.CORS_ORIGIN === '*') {
      return helpers.error('cors.credentials');
    }
    // 安全策略 3：生产禁止 schema 自动同步，结构变更只能走 migration
    if (value.NODE_ENV === 'production' && value.DB_SYNCHRONIZE !== 'false') {
      return helpers.error('db.synchronize.prod');
    }
    // 安全策略 4：生产必须有真实的数据库/Redis 凭证，防止误用本地裸配置上线
    if (value.NODE_ENV === 'production') {
      if (!value.DB_PASSWORD) {
        return helpers.error('db.password.prod');
      }
      if (!value.REDIS_PASSWORD) {
        return helpers.error('redis.password.prod');
      }
    }
    // 连接池下限不得超过上限（pg Pool 会直接抛错，提前拦截给出可读消息）
    const poolMax = Number(value.DB_POOL_MAX);
    const poolMin = Number(value.DB_POOL_MIN);
    if (poolMin > poolMax) {
      return helpers.error('db.pool.range');
    }
    // 驱动级超时顺序：两者都启用（>0）时，服务端必须先终止（statement < query）——
    // pg 的 query_timeout 到达时只本地回调失败、不取消服务端查询，若客户端先到，
    // 服务端仍会跑满 statement_timeout；任一为 0 表示显式禁用该项，不参与比较
    const queryTimeout = Number(value.DB_QUERY_TIMEOUT_MS);
    const statementTimeout = Number(value.DB_STATEMENT_TIMEOUT_MS);
    if (
      queryTimeout > 0 &&
      statementTimeout > 0 &&
      statementTimeout >= queryTimeout
    ) {
      return helpers.error('db.timeout.order');
    }
    // 安全策略 5：生产必须显式配置 TRUST_PROXY（无代理直连设 false），
    // 防止默认信任代理后客户端伪造 X-Forwarded-For 绕过限流
    if (value.NODE_ENV === 'production' && value.TRUST_PROXY === undefined) {
      return helpers.error('trustProxy.prod');
    }
    // 安全策略 6：生产必须显式配置 CORS_ORIGIN——不允许默认通配 * 静默上线
    //（公开 API 用 * 需刻意决策并显式写出；组合 *+credentials 已被策略 2 拒绝）
    if (value.NODE_ENV === 'production' && value.CORS_ORIGIN === undefined) {
      return helpers.error('cors.origin.prod');
    }
    // 安全策略 7：生产必须显式配置 JWT_SECRET（开发兜底弱密钥严禁上线）
    if (value.NODE_ENV === 'production' && value.JWT_SECRET === undefined) {
      return helpers.error('jwt.secret.prod');
    }
    // 弱密钥黑名单（仅生产）：示例/占位值哪怕长度达标也不允许上线
    //（docker/.env.prod.example 的占位符本身有 41 字符，min(16) 拦不住）；
    // 开发环境放行——jwtConfig 工厂的兜底弱密钥就是 dev-only-secret-change-me
    if (
      value.NODE_ENV === 'production' &&
      typeof value.JWT_SECRET === 'string' &&
      /(change_me|dev-only-secret)/i.test(value.JWT_SECRET)
    ) {
      return helpers.error('jwt.secret.weak');
    }
    // access token 必须显著短于 refresh token（刷新链路的续期能力设计前提）；
    // 配置成相等或倒挂会让 access 形同 refresh，轮换失去意义
    const accessTtl = Number(value.JWT_ACCESS_TTL_SECONDS);
    const refreshTtl = Number(value.JWT_REFRESH_TTL_SECONDS);
    if (
      Number.isFinite(accessTtl) &&
      Number.isFinite(refreshTtl) &&
      accessTtl >= refreshTtl
    ) {
      return helpers.error('jwt.ttl.order');
    }
    return value;
  }, '跨字段安全规则')
  .messages({
    'swagger.prod': '生产环境禁止开启 SWAGGER_ENABLED',
    'cors.credentials':
      'CORS_CREDENTIALS=true 不允许 CORS_ORIGIN=*（浏览器拒绝该组合）',
    'db.synchronize.prod':
      '生产环境禁止 DB_SYNCHRONIZE=true（schema 变更走 migration）',
    'db.password.prod': '生产环境必须显式配置 DB_PASSWORD',
    'redis.password.prod': '生产环境必须显式配置 REDIS_PASSWORD',
    'db.pool.range': 'DB_POOL_MIN 不能大于 DB_POOL_MAX',
    'db.timeout.order':
      'DB_STATEMENT_TIMEOUT_MS 必须小于 DB_QUERY_TIMEOUT_MS（服务端先终止）；任一为 0 表示禁用该项超时',
    'trustProxy.prod': '生产环境必须显式配置 TRUST_PROXY（无代理直连设 false）',
    'cors.origin.prod':
      '生产环境必须显式配置 CORS_ORIGIN（不允许默认通配 * 静默上线）',
    'jwt.secret.prod': '生产环境必须显式配置 JWT_SECRET',
    'jwt.secret.weak':
      'JWT_SECRET 使用了示例/占位密钥（change_me / dev-only-secret），严禁上线',
    'jwt.ttl.order':
      'JWT_ACCESS_TTL_SECONDS 必须小于 JWT_REFRESH_TTL_SECONDS（access 应显著短于 refresh）',
  });
