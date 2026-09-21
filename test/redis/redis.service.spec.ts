import type { Redis } from 'ioredis';

import { RedisService } from '../../src/redis/redis.service';

type MockClient = {
  get: jest.Mock;
  set: jest.Mock;
  setex: jest.Mock;
  del: jest.Mock;
  ttl: jest.Mock;
  ping: jest.Mock;
  quit: jest.Mock;
};

describe('RedisService', () => {
  let client: MockClient;
  let service: RedisService;

  beforeEach(() => {
    client = {
      get: jest.fn(),
      set: jest.fn(),
      setex: jest.fn(),
      del: jest.fn(),
      ttl: jest.fn(),
      ping: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    service = new RedisService(client as unknown as Redis);
  });

  describe('get', () => {
    it('命中时反序列化 JSON', async () => {
      client.get.mockResolvedValue(JSON.stringify({ a: 1 }));
      await expect(service.get('k')).resolves.toEqual({ a: 1 });
    });

    it('未命中返回 null', async () => {
      client.get.mockResolvedValue(null);
      await expect(service.get('k')).resolves.toBeNull();
    });

    it('Redis 故障时降级为未命中而不是抛错', async () => {
      client.get.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(service.get('k')).resolves.toBeNull();
      // 连接故障不触发坏键删除（读取都没成功，删除无意义）
      expect(client.del).not.toHaveBeenCalled();
    });

    it('脏数据（非法 JSON）降级为未命中并删除坏键自愈', async () => {
      client.get.mockResolvedValue('{not-json');
      client.del.mockResolvedValue(1);
      await expect(service.get('k')).resolves.toBeNull();
      expect(client.del).toHaveBeenCalledWith('k');
    });

    it('坏键删除失败仅记录，不阻断降级', async () => {
      client.get.mockResolvedValue('{not-json');
      client.del.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(service.get('k')).resolves.toBeNull();
      expect(client.del).toHaveBeenCalledWith('k');
    });
  });

  describe('set', () => {
    it('带 TTL 走 setex 并序列化值', async () => {
      await service.set('k', { a: 1 }, 60);
      expect(client.setex).toHaveBeenCalledWith('k', 60, '{"a":1}');
    });

    it('不带 TTL 走普通 set（永不过期）', async () => {
      await service.set('k', 'v');
      expect(client.set).toHaveBeenCalledWith('k', '"v"');
      expect(client.setex).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5])(
      '非法 TTL（%s）直接抛出，防止静默永不过期',
      async (bad) => {
        await expect(service.set('k', 'v', bad)).rejects.toBeInstanceOf(
          RangeError,
        );
        expect(client.setex).not.toHaveBeenCalled();
      },
    );

    it('序列化失败（循环引用）记录并跳过写入', async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(service.set('k', circular)).resolves.toBeUndefined();
      expect(client.set).not.toHaveBeenCalled();
    });

    it('循环引用 + 非法 TTL：非法 TTL 仍按契约抛出（先校验后序列化）', async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(service.set('k', circular, 0)).rejects.toBeInstanceOf(
        RangeError,
      );
      expect(client.set).not.toHaveBeenCalled();
      expect(client.setex).not.toHaveBeenCalled();
    });

    it('Redis 写入故障记录并跳过，不让业务请求 500', async () => {
      client.setex.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(service.set('k', 'v', 60)).resolves.toBeUndefined();
    });
  });

  describe('del', () => {
    it('空参数时不调用底层命令（DEL 无参会抛错）', async () => {
      await service.del();
      expect(client.del).not.toHaveBeenCalled();
    });

    it('多键一次删除', async () => {
      await service.del('a', 'b');
      expect(client.del).toHaveBeenCalledWith('a', 'b');
    });

    it('Redis 故障记录并吞掉', async () => {
      client.del.mockRejectedValue(new Error('down'));
      await expect(service.del('a')).resolves.toBeUndefined();
    });
  });

  it('ttl/ping 透传底层结果', async () => {
    client.ttl.mockResolvedValue(42);
    client.ping.mockResolvedValue('PONG');
    await expect(service.ttl('k')).resolves.toBe(42);
    await expect(service.ping()).resolves.toBe('PONG');
  });

  it('ttl 查询故障时视为无过期时间（-1）', async () => {
    client.ttl.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.ttl('k')).resolves.toBe(-1);
  });

  it('onModuleDestroy 优雅退出：quit 失败时强制 disconnect', async () => {
    client.quit.mockRejectedValue(new Error('closed'));
    const disconnect = jest.fn();
    (client as unknown as Record<string, jest.Mock>).disconnect = disconnect;
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalled();
  });
});
