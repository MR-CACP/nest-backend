import type { RedisConfig } from '../../src/config/types';
import { buildRedisClientOptions } from '../../src/redis/redis.module';

/**
 * buildRedisClientOptions 纯函数测试：
 * commandTimeout 语义为 0=禁用，但 ioredis 对 0 会执行 setTimeout(..., 0)
 * 导致每条命令立即超时，因此仅当大于 0 时才传入该选项（0 映射为不传）。
 */
describe('buildRedisClientOptions', () => {
  const base: RedisConfig = {
    host: 'localhost',
    port: 6379,
    password: '',
    db: 0,
    keyPrefix: 'app:',
    commandTimeoutMs: 5000,
  };

  it('默认固定选项映射正确', () => {
    const options = buildRedisClientOptions(base);
    expect(options).toMatchObject({
      host: 'localhost',
      port: 6379,
      password: undefined,
      db: 0,
      keyPrefix: 'app:',
      maxRetriesPerRequest: 2,
    });
    expect(typeof options.retryStrategy).toBe('function');
  });

  it('commandTimeoutMs>0 时传入 commandTimeout', () => {
    expect(buildRedisClientOptions(base).commandTimeout).toBe(5000);
  });

  it('commandTimeoutMs=0 时映射为不传（禁用语义）', () => {
    const options = buildRedisClientOptions({ ...base, commandTimeoutMs: 0 });
    expect(options).not.toHaveProperty('commandTimeout');
  });
});
