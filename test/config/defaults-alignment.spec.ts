import {
  appConfig,
  buildDatabaseConfigFromEnv,
  buildRedisConfigFromEnv,
  corsConfig,
  logConfig,
  swaggerConfig,
  throttlerConfig,
} from '../../src/config/configuration';
import { envValidationSchema } from '../../src/config/env.validation';

/**
 * 配置默认值对齐回归测试。
 *
 * 项目有两条读取路径：
 * - 运行时：env 文件/process.env -> ConfigModule 的 Joi 校验（补默认值、类型转换）-> 命名空间工厂
 * - CLI（migration 等）：原始 env -> 工厂函数（data-source.ts 手动加载，不经过 Joi）
 *
 * 两条路径必须产出相同配置；任何"Joi 默认值"与"工厂默认值"不一致都会让
 * 应用运行行为和迁移行为漂移（历史上 DB_LOGGING 就漂移过：Joi 默认 'error'，
 * 工厂缺省返回 false）。
 */
describe('配置默认值对齐（Joi schema 与工厂函数）', () => {
  const ORIGINAL_ENV = { ...process.env };

  /** Joi 校验空输入（仅 NODE_ENV）后得到的"全默认值"环境 */
  let validated: NodeJS.ProcessEnv;

  beforeAll(() => {
    const result = envValidationSchema.validate(
      { NODE_ENV: 'development' },
      { abortEarly: false },
    );
    if (result.error) throw result.error;
    validated = result.value as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('数据库配置：原始 env 与 Joi 校验后的 env 产出一致', () => {
    expect(buildDatabaseConfigFromEnv({})).toEqual(
      buildDatabaseConfigFromEnv(validated),
    );
  });

  it('Redis 配置：原始 env 与 Joi 校验后的 env 产出一致', () => {
    expect(buildRedisConfigFromEnv({})).toEqual(
      buildRedisConfigFromEnv(validated),
    );
  });

  it('各命名空间工厂：缺省环境与 Joi 默认值环境产出一致', () => {
    const CONFIG_KEYS = [
      'PORT',
      'TRUST_PROXY',
      'API_PREFIX',
      'LOG_LEVEL',
      'SWAGGER_ENABLED',
      'SWAGGER_PATH',
      'THROTTLE_TTL',
      'THROTTLE_LIMIT',
      'THROTTLE_STORAGE',
      'CORS_ORIGIN',
      'CORS_CREDENTIALS',
      'DB_HOST',
      'DB_PORT',
      'DB_USERNAME',
      'DB_PASSWORD',
      'DB_DATABASE',
      'DB_SSL',
      'DB_SYNCHRONIZE',
      'DB_LOGGING',
      'DB_POOL_MAX',
      'DB_POOL_MIN',
      'DB_POOL_IDLE_TIMEOUT_MS',
      'DB_POOL_CONNECTION_TIMEOUT_MS',
      'DB_QUERY_TIMEOUT_MS',
      'DB_STATEMENT_TIMEOUT_MS',
      'REDIS_HOST',
      'REDIS_PORT',
      'REDIS_PASSWORD',
      'REDIS_DB',
      'REDIS_KEY_PREFIX',
      'REDIS_COMMAND_TIMEOUT_MS',
    ];

    // 缺省路径：清空全部配置键，仅保留 NODE_ENV
    process.env.NODE_ENV = 'development';
    for (const key of CONFIG_KEYS) {
      delete process.env[key];
    }
    const fromDefaults = {
      app: appConfig(),
      cors: corsConfig(),
      swagger: swaggerConfig(),
      throttler: throttlerConfig(),
      log: logConfig(),
    };

    // Joi 默认值路径：把校验结果灌回 process.env（模拟 ConfigModule 校验后的状态）
    Object.assign(process.env, validated);
    const fromValidated = {
      app: appConfig(),
      cors: corsConfig(),
      swagger: swaggerConfig(),
      throttler: throttlerConfig(),
      log: logConfig(),
    };

    expect(fromValidated).toEqual(fromDefaults);
  });
});
