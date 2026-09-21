import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDatabaseConfigFromEnv,
  buildRedisConfigFromEnv,
  parseDbLogging,
  parseMigrationLockTimeoutMs,
} from '../../src/config/configuration';
import type { DatabaseConfig } from '../../src/config/types';
import { buildTypeOrmOptions } from '../../src/database/database.module';

describe('parseDbLogging', () => {
  it('缺失/false/空串关闭日志', () => {
    expect(parseDbLogging(undefined)).toBe(false);
    expect(parseDbLogging('false')).toBe(false);
    expect(parseDbLogging('')).toBe(false);
  });

  it('true 与 all 归一为 all', () => {
    expect(parseDbLogging('true')).toBe('all');
    expect(parseDbLogging('all')).toBe('all');
  });

  it('逗号分隔解析为级别数组并去空白', () => {
    expect(parseDbLogging('error, query ')).toEqual(['error', 'query']);
  });

  it('无有效类别（如 ",,"）回退 false', () => {
    expect(parseDbLogging(',,')).toBe(false);
  });
});

describe('buildDatabaseConfigFromEnv', () => {
  it('空环境返回默认值且类型正确', () => {
    const cfg = buildDatabaseConfigFromEnv({});
    expect(cfg).toMatchObject({
      host: 'localhost',
      port: 5432,
      username: 'app',
      password: '',
      database: 'app_db',
      ssl: false,
      sslRejectUnauthorized: true,
      synchronize: false,
      queryTimeoutMs: 5000,
      statementTimeoutMs: 4000,
      // 缺省默认 'error'（与 Joi schema 对齐）：只记录失败查询，而不是完全关闭
      logging: ['error'],
    });
    expect(cfg.pool).toEqual({
      max: 10,
      min: 2,
      idleTimeoutMs: 30000,
      connectionTimeoutMs: 10000,
    });
    expect(typeof cfg.port).toBe('number');
  });

  it('显式环境变量逐项覆盖并做数字/布尔解析', () => {
    const cfg = buildDatabaseConfigFromEnv({
      DB_HOST: 'db.internal',
      DB_PORT: '6543',
      DB_USERNAME: 'svc',
      DB_PASSWORD: 'p@ss',
      DB_DATABASE: 'orders',
      DB_SSL: 'true',
      DB_SSL_REJECT_UNAUTHORIZED: 'false',
      DB_SYNCHRONIZE: 'true',
      DB_LOGGING: 'query,error',
      DB_POOL_MAX: '50',
      DB_POOL_MIN: '5',
      DB_POOL_IDLE_TIMEOUT_MS: '1234',
      DB_POOL_CONNECTION_TIMEOUT_MS: '5678',
      DB_QUERY_TIMEOUT_MS: '8000',
      DB_STATEMENT_TIMEOUT_MS: '3000',
    });
    expect(cfg).toEqual({
      host: 'db.internal',
      port: 6543,
      username: 'svc',
      password: 'p@ss',
      database: 'orders',
      ssl: true,
      sslRejectUnauthorized: false,
      synchronize: true,
      logging: ['query', 'error'],
      queryTimeoutMs: 8000,
      statementTimeoutMs: 3000,
      pool: {
        max: 50,
        min: 5,
        idleTimeoutMs: 1234,
        connectionTimeoutMs: 5678,
      },
    });
  });
});

describe('buildRedisConfigFromEnv', () => {
  it('空环境返回本地默认值', () => {
    expect(buildRedisConfigFromEnv({})).toEqual({
      host: 'localhost',
      port: 6379,
      password: '',
      db: 0,
      keyPrefix: 'app:',
      commandTimeoutMs: 5000,
    });
  });

  it('显式值覆盖并解析数字', () => {
    expect(
      buildRedisConfigFromEnv({
        REDIS_HOST: 'cache',
        REDIS_PORT: '6380',
        REDIS_PASSWORD: 'secret',
        REDIS_DB: '3',
        REDIS_KEY_PREFIX: 'svc:',
        REDIS_COMMAND_TIMEOUT_MS: '3000',
      }),
    ).toEqual({
      host: 'cache',
      port: 6380,
      password: 'secret',
      db: 3,
      keyPrefix: 'svc:',
      commandTimeoutMs: 3000,
    });
  });
});

describe('parseMigrationLockTimeoutMs', () => {
  it('缺省返回默认 10000', () => {
    expect(parseMigrationLockTimeoutMs({})).toBe(10000);
  });

  it('显式值覆盖（含 0=禁用）', () => {
    expect(
      parseMigrationLockTimeoutMs({ DB_MIGRATION_LOCK_TIMEOUT_MS: '3000' }),
    ).toBe(3000);
    expect(
      parseMigrationLockTimeoutMs({ DB_MIGRATION_LOCK_TIMEOUT_MS: '0' }),
    ).toBe(0);
  });

  it('非法值回退默认（CLI 不经 Joi，防配置笔误直接失败）', () => {
    expect(
      parseMigrationLockTimeoutMs({ DB_MIGRATION_LOCK_TIMEOUT_MS: 'abc' }),
    ).toBe(10000);
    expect(
      parseMigrationLockTimeoutMs({ DB_MIGRATION_LOCK_TIMEOUT_MS: '-5' }),
    ).toBe(10000);
  });

  it('PG 毫秒 GUC 上界（int32 max）与超界值', () => {
    // 上界本身合法
    expect(
      parseMigrationLockTimeoutMs({
        DB_MIGRATION_LOCK_TIMEOUT_MS: '2147483647',
      }),
    ).toBe(2147483647);
    // 超出上界：PG 以 out of range 拒绝，回退默认
    expect(
      parseMigrationLockTimeoutMs({
        DB_MIGRATION_LOCK_TIMEOUT_MS: '2147483648',
      }),
    ).toBe(10000);
    // 超过 Number.MAX_SAFE_INTEGER：isInteger 会误判为整数，需 safe 检查
    expect(
      parseMigrationLockTimeoutMs({
        DB_MIGRATION_LOCK_TIMEOUT_MS: '9007199254740993',
      }),
    ).toBe(10000);
  });
});

describe('buildTypeOrmOptions', () => {
  const base: DatabaseConfig = {
    host: 'localhost',
    port: 5432,
    username: 'app',
    password: 'pw',
    database: 'app_db',
    ssl: false,
    sslRejectUnauthorized: true,
    synchronize: false,
    logging: false,
    pool: { max: 10, min: 2, idleTimeoutMs: 30000, connectionTimeoutMs: 10000 },
    queryTimeoutMs: 5000,
    statementTimeoutMs: 4000,
  };

  it('连接字段与 pg 连接池参数映射正确', () => {
    const options = buildTypeOrmOptions(base);
    expect(options).toMatchObject({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'app',
      password: 'pw',
      database: 'app_db',
      synchronize: false,
      logging: false,
      autoLoadEntities: true,
      retryAttempts: 3,
      retryDelay: 1000,
      extra: {
        max: 10,
        min: 2,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        query_timeout: 5000,
        statement_timeout: 4000,
      },
    });
  });

  it('ssl 开启时默认校验服务端证书链', () => {
    const options = buildTypeOrmOptions({ ...base, ssl: true });
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('DB_SSL_REJECT_UNAUTHORIZED=false 显式开启不校验证书（仅限开发实验）', () => {
    const options = buildTypeOrmOptions({
      ...base,
      ssl: true,
      sslRejectUnauthorized: false,
    });
    expect(options.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('配置 DB_SSL_CA 时读取 PEM 并强制校验证书链', () => {
    const caPath = join(tmpdir(), 'nest-test-ca.pem');
    writeFileSync(
      caPath,
      '-----BEGIN CERTIFICATE-----\nFAKE-CA-CONTENT\n-----END CERTIFICATE-----',
    );
    try {
      const options = buildTypeOrmOptions({
        ...base,
        ssl: true,
        sslCa: caPath,
      });
      const ssl = options.ssl as unknown as {
        rejectUnauthorized: boolean;
        ca: string | Buffer;
      };
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(String(ssl.ca)).toContain('BEGIN CERTIFICATE');
    } finally {
      rmSync(caPath, { force: true });
    }
  });

  it('entities/migrations 使用 glob 且 migrations 锚定本模块目录', () => {
    const options = buildTypeOrmOptions(base);
    expect(options.migrations).toHaveLength(1);
    expect(String(options.migrations[0])).toMatch(
      /migrations[\\/]\*\.\{ts,js\}/,
    );
    expect(String(options.entities[0])).toMatch(/\.entity\.\{ts,js\}$/);
  });

  it('overrides 允许覆盖（CLI 场景强制 synchronize=false 等）', () => {
    const options = buildTypeOrmOptions(
      { ...base, synchronize: true },
      { synchronize: false },
    );
    expect(options.synchronize).toBe(false);
  });
});
