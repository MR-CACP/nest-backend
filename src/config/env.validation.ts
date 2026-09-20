import Joi from 'joi';

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

  // 反向代理可信层数，取值语义见 types.ts 的 AppConfig.trustProxy
  TRUST_PROXY: Joi.string()
    .pattern(/^(true|false|\d+)$/)
    .default('1'),

  // 演示/调试路由显式开关（不依赖 NODE_ENV 推断）
  DEMO_ROUTES_ENABLED: Joi.string().valid('true', 'false').default('false'),

  API_PREFIX: Joi.string().trim().min(1).default('api'),

  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  SWAGGER_PATH: Joi.string().trim().min(1).default('docs'),

  THROTTLE_TTL: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),

  CORS_ORIGIN: Joi.string().trim().min(1).default('*'),
  CORS_CREDENTIALS: Joi.string().valid('true', 'false').default('false'),
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
    return value;
  }, '跨字段安全规则')
  .messages({
    'swagger.prod': '生产环境禁止开启 SWAGGER_ENABLED',
    'cors.credentials':
      'CORS_CREDENTIALS=true 不允许 CORS_ORIGIN=*（浏览器拒绝该组合）',
  });
