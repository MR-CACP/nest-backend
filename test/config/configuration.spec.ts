import { appConfig } from '../../src/config/configuration';

/** 直接调用配置工厂（绕过 ConfigModule），验证关键字段的运行时校验与转换 */
describe('configuration/appConfig', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('NODE_ENV 校验', () => {
    it.each([undefined, '', 'staging'])(
      '非法值 %j 时抛出错误',
      (raw: string | undefined) => {
        if (raw === undefined) {
          delete process.env.NODE_ENV;
        } else {
          process.env.NODE_ENV = raw;
        }
        expect(() => appConfig()).toThrow('NODE_ENV 非法');
      },
    );

    it('合法值正常解析', () => {
      process.env.NODE_ENV = 'test';
      expect(appConfig().env).toBe('test');
    });
  });

  describe('TRUST_PROXY 转换', () => {
    it.each([
      ['false', false],
      ['true', true],
      ['2', 2],
      [undefined, 1], // 缺省时默认信任一层
    ] as const)('TRUST_PROXY=%j -> %j', (raw, expected) => {
      process.env.NODE_ENV = 'test';
      if (raw === undefined) {
        delete process.env.TRUST_PROXY;
      } else {
        process.env.TRUST_PROXY = raw;
      }
      expect(appConfig().trustProxy).toBe(expected);
    });
  });

  describe('DEMO_ROUTES_ENABLED 解析', () => {
    it.each([
      ['true', true],
      ['false', false],
      [undefined, false], // 缺省默认关闭
    ] as const)('DEMO_ROUTES_ENABLED=%j -> %j', (raw, expected) => {
      process.env.NODE_ENV = 'test';
      if (raw === undefined) {
        delete process.env.DEMO_ROUTES_ENABLED;
      } else {
        process.env.DEMO_ROUTES_ENABLED = raw;
      }
      expect(appConfig().demoRoutesEnabled).toBe(expected);
    });
  });
});
