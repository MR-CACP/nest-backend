import type { INestApplication } from '@nestjs/common';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { formatValidationErrors } from './common/utils/error-messages';
import type { AppConfig, CorsConfig, SwaggerConfig } from './config/types';

// 用 require 而非静态 import：import JSON 会让 tsc 把 package.json 计入编译输入，
// rootDir 上移到项目根，产物从 dist/main.js 变成 dist/src/main.js，start:prod 失效。
// 读取函数可注入以便测试回退路径；读取失败（部署制品只含 dist/ 时）不阻断启动
export function readPkgVersion(read?: () => { version?: string }): string {
  try {
    if (read) {
      return read().version ?? '0.0.0';
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { version } = require('../package.json') as { version?: string };
    return version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 应用装配（main.ts 与 e2e 共用，保证测试构建的应用与真实应用等价）：
 * helmet / trust proxy / 全局校验管道 / 路由前缀 / CORS / Swagger。
 * 全局过滤器、守卫、拦截器注册在 app.module.ts 的 providers 中。
 */
export function configureApp(app: INestApplication): {
  appConfig: AppConfig;
  corsConfig: CorsConfig;
  swaggerConfig: SwaggerConfig;
} {
  const configService = app.get(ConfigService);
  const appConfig = configService.getOrThrow<AppConfig>('app');
  const corsConfig = configService.getOrThrow<CorsConfig>('cors');
  const swaggerConfig = configService.getOrThrow<SwaggerConfig>('swagger');

  app.use(helmet()); // 安全响应头

  // X-Request-Id 关联 ID 由 pino-http 的 genReqId 统一生成/回写（见 app.module.ts 与
  // common/utils/request-id.ts）：日志 req.id 与响应头必须同源，这里不再单独挂中间件

  // 信任反向代理：从 X-Forwarded-For 取真实客户端 IP（层数经 TRUST_PROXY 配置化，
  // 无代理直连部署应设 false，避免客户端伪造 X-Forwarded-For 影响限流与日志）。
  // 网关侧应清洗转发头；多实例部署时限流仍需换 Redis 存储
  const expressApp = app.getHttpAdapter().getInstance() as {
    set: (key: string, value: unknown) => void;
  };
  expressApp.set('trust proxy', appConfig.trustProxy);

  // ---------- 全局参数校验管道 ----------
  app.useGlobalPipes(
    new ValidationPipe({
      // 载荷自动转换为 DTO 实例（保持类型严格：JSON 字段类型不匹配会返回 400，
      // query 参数需要的字符串转数字在 DTO 字段上用 @Type(() => Number) 处理）
      transform: true,
      // 剔除 DTO 未声明的属性，防止意外字段进入业务层
      whitelist: true,
      // 出现未声明属性时直接返回 400，而不是静默剔除
      forbidNonWhitelisted: true,
      // 校验错误消息统一中文化：DTO 自定义的中文消息透传，
      // class-validator 默认英文消息按模板翻译
      exceptionFactory: (errors) =>
        new BadRequestException(formatValidationErrors(errors)),
    }),
  );

  // ---------- 路由前缀与跨域 ----------
  app.setGlobalPrefix(appConfig.prefix);
  app.enableCors({
    origin: corsConfig.origins,
    credentials: corsConfig.credentials,
  });

  // ---------- Swagger 接口文档（生产环境由配置强制关闭） ----------
  if (swaggerConfig.enabled) {
    const documentConfig = new DocumentBuilder()
      .setTitle('nest-backend API')
      .setDescription('NestJS 后端服务接口文档')
      .setVersion(readPkgVersion()) // 与 package.json 保持一致，避免双真相源
      .build();
    const document = SwaggerModule.createDocument(app, documentConfig);
    SwaggerModule.setup(swaggerConfig.path, app, document);
  }

  return { appConfig, corsConfig, swaggerConfig };
}
