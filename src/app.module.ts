import { join } from 'node:path';

import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { LoggerModule } from 'nestjs-pino';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { genRequestId } from './common/utils/request-id';
import {
  appConfig,
  corsConfig,
  databaseConfig,
  getEnvFilePaths,
  jwtConfig,
  logConfig,
  redisConfig,
  swaggerConfig,
  throttlerConfig,
} from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import type { NodeEnv, ThrottlerConfig } from './config/types';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { UsersModule } from './modules/users/users.module';
import { REDIS_CLIENT } from './redis/redis.constants';
import { RedisModule } from './redis/redis.module';

// 运行环境决定加载哪些 env 文件。
// 注意：NODE_ENV 必须由进程环境注入（scripts 已用 cross-env 写入，生产由部署平台注入），
// 不能写在 .env 文件里——加载哪个环境文件本身就取决于该变量，属于循环依赖、实际无效。
// main.ts 已 fail-fast 保证 NODE_ENV 合法，此处收窄为 NodeEnv
const nodeEnv = (process.env.NODE_ENV ?? 'development') as NodeEnv;

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
      // 加载优先级与 TypeORM CLI（data-source.ts）共用同一份列表（getEnvFilePaths），
      // 防止两处各自维护导致漂移；process.env 中已有的变量始终最高
      envFilePath: getEnvFilePaths(nodeEnv).map((file) =>
        join(process.cwd(), file),
      ),
      load: [
        appConfig,
        corsConfig,
        logConfig,
        swaggerConfig,
        throttlerConfig,
        databaseConfig,
        redisConfig,
        jwtConfig,
      ],
      validationSchema: envValidationSchema,
      // allowUnknown 无需设置：schema 中已声明 .unknown(true)
      validationOptions: {
        abortEarly: false,
      },
    }),
    // 特性模块按需注册命名空间示例：imports: [ConfigModule.forFeature(swaggerConfig)]

    // 限速模块：从配置命名空间读取参数（ttl 秒 -> 毫秒）。
    // THROTTLE_STORAGE=redis 时计数存 Redis（多副本共享限额）；memory 仅单进程，
    // 多副本部署时限额=limit×副本数
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (configService: ConfigService, redisClient: Redis) => {
        const throttler =
          configService.getOrThrow<ThrottlerConfig>('throttler');
        return {
          throttlers: [
            {
              ttl: throttler.ttl * 1000,
              limit: throttler.limit,
            },
          ],
          storage:
            throttler.storage === 'redis'
              ? // 复用全局 Redis 客户端；前缀含 keyPrefix，天然按 REDIS_KEY_PREFIX 隔离
                new ThrottlerStorageRedisService(redisClient)
              : undefined,
        };
      },
    }),

    // 日志模块：级别来自配置；开发环境使用 pino-pretty 美化输出，
    // 并对敏感请求头做脱敏（redact）
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        pinoHttp: {
          // 关联 ID 与响应头由 genReqId 统一产生/回写（复用合法传入值，否则 UUID），
          // 保证日志 req.id 与用户拿到的 X-Request-Id 一致（见 common/utils/request-id.ts）
          genReqId: genRequestId,
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

    // 数据层：PostgreSQL（TypeORM，实体经 autoLoadEntities 收集）与 Redis（全局模块，
    // 缓存门面 + 限速存储共用客户端）
    DatabaseModule,
    RedisModule,
    HealthModule,
    // 认证模块：本阶段注册 User / RefreshToken 数据模型（实体见 src/modules/auth/entities）
    AuthModule,
    // 审计模块：login_logs（登录日志）+ audit_logs（管理操作审计）写入与查询
    AuditModule,
    // RBAC 权限体系：roles/permissions 数据模型 + RolesGuard 授权守卫
    // （接口用 @UseGuards(JwtAuthGuard, RolesGuard) + @Roles/@Permissions 声明）
    RbacModule,
    // 用户管理模块：/api/users（列表 + 角色分配）；用户域接口归此模块，
    // 与 rbac 的 /roles、/permissions 分工
    UsersModule,
    // 会话管理模块：在线列表 + 强制下线（数据源 refresh_tokens + session_version 递增）
    SessionsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
  ],
})
export class AppModule {}
