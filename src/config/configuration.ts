import { registerAs } from '@nestjs/config';

import type {
  AppConfig,
  CorsConfig,
  LogConfig,
  LogLevel,
  NodeEnv,
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
  const rawTrustProxy = process.env.TRUST_PROXY ?? '1';
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
    demoRoutesEnabled: process.env.DEMO_ROUTES_ENABLED === 'true',
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
}));

export const logConfig = registerAs('log', (): LogConfig => ({
  level: (process.env.LOG_LEVEL as LogLevel) ?? 'info',
}));
