import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import {
  buildDatabaseConfigFromEnv,
  getEnvFilePaths,
  parseMigrationLockTimeoutMs,
} from '../config/configuration';
import type { NodeEnv } from '../config/types';
import { buildTypeOrmOptions } from './database.module';

/**
 * TypeORM CLI 专用 DataSource（migration 生成/执行/回滚）。
 * 不启动 Nest 容器：按与 ConfigModule 相同的优先级手动加载 env 文件
 * （getEnvFilePaths 与 app.module.ts 共用同一份加载顺序；
 * dotenv 默认不覆盖 process.env 中已有的变量，因此容器注入的变量始终最高；
 * 生产镜像中这些文件不存在，连接信息完全来自环境注入）。
 */
const nodeEnv = (process.env.NODE_ENV ?? 'development') as NodeEnv;
for (const file of getEnvFilePaths(nodeEnv)) {
  const path = join(process.cwd(), file);
  if (existsSync(path)) {
    loadDotenv({ path });
  }
}

// 迁移专项超时：不复用应用请求超时（statement/query 置 0，长 DDL 不应被中断），
// 但锁等待必须有限（默认 10s，可经 DB_MIGRATION_LOCK_TIMEOUT_MS 配置）——
// 防止迁移互相/自身死锁时永久挂起；整体执行时长由编排层控制
// （compose migrate 命令 timeout 包装，见 docker-compose.prod.yml）
const migrationLockTimeoutMs = parseMigrationLockTimeoutMs();
const baseOptions = buildTypeOrmOptions({
  ...buildDatabaseConfigFromEnv(),
  queryTimeoutMs: 0,
  statementTimeoutMs: 0,
});
// pg 的 extra 类型为 any：显式收窄为对象再展开，避免 no-unsafe-assignment
const poolExtra = baseOptions.extra as Record<string, unknown> | undefined;

export default new DataSource({
  ...baseOptions,
  // extra.options 是 pg 连接参数（等价 psql -c）：仅对迁移连接生效
  extra: {
    ...poolExtra,
    options: `-c lock_timeout=${migrationLockTimeoutMs}`,
  },
  // CLI 永远禁止 synchronize：generate 靠对比实体与库内 schema 产出 migration，
  // 若允许同步则 schema 已被偷偷改过，生成的 migration 会是空的
  synchronize: false,
});
