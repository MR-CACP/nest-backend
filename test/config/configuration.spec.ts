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
      [undefined, false], // 缺省时不信任代理（安全默认）
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
});
