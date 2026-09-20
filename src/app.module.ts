import { join } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import {
  appConfig,
  corsConfig,
  logConfig,
  swaggerConfig,
  throttlerConfig,
} from './config/configuration';
import { envValidationSchema } from './config/env.validation';

// 运行环境决定加载哪些 env 文件。
// 注意：NODE_ENV 必须由进程环境注入（scripts 已用 cross-env 写入，生产由部署平台注入），
// 不能写在 .env 文件里——加载哪个环境文件本身就取决于该变量，属于循环依赖、实际无效
const nodeEnv = process.env.NODE_ENV ?? 'development';

@Module({
  imports: [
    // 全局配置模块：envFilePath 按优先级从上到下加载（先读到的变量优先生效，
    // process.env 中已有的变量始终最高），validationSchema 对 process.env 做 fail-fast 校验
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // 支持 ${VAR} / $VAR 变量引用：未定义变量展开为空串，唯一转义符是反斜杠
      // （pa$$word 需写成 pa\$\$word，单引号包裹无效——展开发生在引号剥离之后）；
      // 含 $ 的值更稳妥的做法是放 .env.{NODE_ENV}.local 或由部署平台注入
      expandVariables: true,
      envFilePath: [
        join(process.cwd(), `.env.${nodeEnv}.local`),
        join(process.cwd(), `.env.${nodeEnv}`),
        join(process.cwd(), '.env.local'),
        join(process.cwd(), '.env'),
      ],
      load: [appConfig, corsConfig, logConfig, swaggerConfig, throttlerConfig],
      validationSchema: envValidationSchema,
      // allowUnknown 无需设置：schema 中已声明 .unknown(true)
      validationOptions: {
        abortEarly: false,
      },
    }),
    // 特性模块按需注册命名空间示例：imports: [ConfigModule.forFeature(swaggerConfig)]

    // 限速模块：从配置命名空间读取参数（ttl 秒 -> 毫秒）。
    // 注意：默认内存存储不跨实例，多副本部署时限额=limit×副本数，生产需换 Redis 存储
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            ttl: configService.getOrThrow<number>('throttler.ttl') * 1000,
            limit: configService.getOrThrow<number>('throttler.limit'),
          },
        ],
      }),
    }),

    // 日志模块：级别来自配置；开发环境使用 pino-pretty 美化输出，
    // 并对敏感请求头做脱敏（redact）
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        pinoHttp: {
          level: configService.getOrThrow<string>('log.level'),
          transport:
            nodeEnv !== 'production'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              // pino-http 默认序列化全部响应头，set-cookie 携带会话凭证必须脱敏
              'res.headers["set-cookie"]',
            ],
            censor: '[REDACTED]',
          },
        },
      }),
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule {}
