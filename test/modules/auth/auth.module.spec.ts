import { ConfigService } from '@nestjs/config';

import { buildJwtModuleOptions } from '@/modules/auth/auth.module';

describe('AuthModule JWT 装配', () => {
  it('jwt 配置存在：secret 与 expiresIn 正确透传', () => {
    const configService = {
      getOrThrow: jest.fn(() => ({
        secret: 'test-secret',
        accessTtlSeconds: 900,
        refreshTtlSeconds: 604800,
      })),
    } as unknown as ConfigService;

    const options = buildJwtModuleOptions(configService);
    expect(options).toEqual({
      secret: 'test-secret',
      signOptions: { expiresIn: 900 },
    });
  });

  it('jwt 配置缺失：启动即抛错（fail-fast，不允许无密钥静默运行）', () => {
    const configService = {
      getOrThrow: jest.fn(() => {
        throw new Error('Config key "jwt" does not exist');
      }),
    } as unknown as ConfigService;

    expect(() => buildJwtModuleOptions(configService)).toThrow(
      'Config key "jwt" does not exist',
    );
  });
});
