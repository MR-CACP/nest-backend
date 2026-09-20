import { envValidationSchema } from '../../src/config/env.validation';

describe('envValidationSchema', () => {
  const validEnv = { NODE_ENV: 'development', PORT: '3000' };

  it('合法环境变量通过校验', () => {
    const { error } = envValidationSchema.validate(validEnv);
    expect(error).toBeUndefined();
  });

  it('未声明的变量被允许（unknown）', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      SOME_EXTRA_VAR: 'x',
    });
    expect(error).toBeUndefined();
  });

  it.each([
    [{ ...validEnv, PORT: 'abc' }, 'PORT'],
    [{ ...validEnv, NODE_ENV: 'staging' }, 'NODE_ENV'],
    // NODE_ENV 必填：缺失（如 worker/cron 等绕过 main.ts 的入口）时启动失败而非回退 development
    [{ PORT: '3000' }, 'NODE_ENV'],
    [{ ...validEnv, SWAGGER_ENABLED: 'yes' }, 'SWAGGER_ENABLED'],
  ])('非法值 %j 触发校验失败', (env, field) => {
    const { error } = envValidationSchema.validate(env);
    expect(error).toBeDefined();
    expect(error?.details.some((d) => d.path.includes(field))).toBe(true);
  });

  it('生产环境开启 Swagger 被拒绝', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      SWAGGER_ENABLED: 'true',
    });
    expect(error?.message).toContain('生产环境禁止开启 SWAGGER_ENABLED');
  });

  it('生产环境关闭 Swagger 通过校验', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      SWAGGER_ENABLED: 'false',
    });
    expect(error).toBeUndefined();
  });

  it('CORS_CREDENTIALS=true 搭配 CORS_ORIGIN=* 被拒绝', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      CORS_CREDENTIALS: 'true',
      CORS_ORIGIN: '*',
    });
    expect(error?.message).toContain(
      'CORS_CREDENTIALS=true 不允许 CORS_ORIGIN=*',
    );
  });

  it('CORS_CREDENTIALS=true 搭配具体来源通过校验', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      CORS_CREDENTIALS: 'true',
      CORS_ORIGIN: 'https://a.com,https://b.com',
    });
    expect(error).toBeUndefined();
  });
});
