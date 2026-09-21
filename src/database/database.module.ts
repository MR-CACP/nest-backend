import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { DataSourceOptions } from 'typeorm';

import type { DatabaseConfig } from '../config/types';

/** 本项目锁定 PostgreSQL：从联合类型中筛出 pg 分支，避免类型退化 */
export type PostgresDataSourceOptions = Extract<
  DataSourceOptions,
  { type: 'postgres' }
>;
export type AppTypeOrmOptions = TypeOrmModuleOptions &
  PostgresDataSourceOptions;

/**
 * TypeORM 连接选项构建：DatabaseModule（Nest 运行时）与 data-source.ts（CLI）共用，
 * 保证迁移生成/执行与应用运行使用完全一致的连接与实体发现规则。
 * 迁移文件同时匹配 .ts/.js：CLI 走 ts-node 时命中 src 下的 .ts，
 * 容器内跑编译产物时命中 dist 下的 .js。
 */
export function buildTypeOrmOptions(
  db: DatabaseConfig,
  overrides: Partial<AppTypeOrmOptions> = {},
): AppTypeOrmOptions {
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.database,
    // TLS 语义：DB_SSL 开启时默认校验服务端证书链（rejectUnauthorized=true）；
    // 提供 DB_SSL_CA（PEM 路径）时读取并强制校验证书链；
    // DB_SSL_REJECT_UNAUTHORIZED=false 仅限本地/内网实验显式开启——指向外部托管数据库
    // 时不校验证书等于接受任意证书，存在 MITM 风险（见 types.ts DatabaseConfig 注释）
    ssl: db.ssl
      ? {
          rejectUnauthorized: db.sslCa ? true : db.sslRejectUnauthorized,
          ...(db.sslCa ? { ca: readFileSync(db.sslCa) } : {}),
        }
      : false,
    synchronize: db.synchronize,
    logging: db.logging,
    // 特性模块用 TypeOrmModule.forFeature([...]) 注册实体，由 autoLoadEntities 收集；
    // 兜底 glob 供不经过 Nest 上下文的场景（CLI/脚本）发现实体
    autoLoadEntities: true,
    entities: [join(__dirname, '/../**/*.entity.{ts,js}')],
    migrations: [join(__dirname, 'migrations/*.{ts,js}')],
    // 连接池参数直通 node-postgres Pool（见 pg 文档），控制并发与空闲回收；
    // 驱动级查询超时分双侧：statement_timeout（服务端主动终止，先触发）<
    // query_timeout（客户端兜底）——pg 的 query_timeout 只本地回调失败、不会取消
    // 服务端查询；管理命令（migration CLI）在 data-source.ts 显式覆盖为 0
    extra: {
      max: db.pool.max,
      min: db.pool.min,
      idleTimeoutMillis: db.pool.idleTimeoutMs,
      connectionTimeoutMillis: db.pool.connectionTimeoutMs,
      query_timeout: db.queryTimeoutMs,
      statement_timeout: db.statementTimeoutMs,
    },
    // 启动期数据库不可达时重试 3 次（每次间隔 1s）后 fail-fast，
    // 交由进程管理器/编排器重启，而不是静默降级
    retryAttempts: 3,
    retryDelay: 1000,
    ...overrides,
  };
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): AppTypeOrmOptions =>
        // 运行时命名空间必须存在（ConfigModule load 已注册）；缺失即抛错，
        // 不静默回退解析 process.env——回退只会掩盖配置装配错误。
        // CLI 路径不经 ConfigService，直接走 buildDatabaseConfigFromEnv（见 data-source.ts）
        buildTypeOrmOptions(
          configService.getOrThrow<DatabaseConfig>('database'),
        ),
    }),
  ],
})
export class DatabaseModule {}
