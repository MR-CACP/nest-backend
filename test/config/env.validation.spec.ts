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
      // 生产新增强制项：数据库与 Redis 必须显式配置凭证，反向代理层数必须显式声明，
      // JWT 签名密钥必须显式配置（>=16 字符，无默认值）
      DB_PASSWORD: 's3cret',
      REDIS_PASSWORD: 'r3dis',
      TRUST_PROXY: 'false',
      CORS_ORIGIN: 'https://app.example.com',
      JWT_SECRET: 'prod-secret-0123456789abcdef',
    });
    expect(error).toBeUndefined();
  });

  it('生产环境缺少 JWT_SECRET 被拒绝（无默认值，防弱密钥静默上线）', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      DB_PASSWORD: 's3cret',
      REDIS_PASSWORD: 'r3dis',
      TRUST_PROXY: 'false',
      CORS_ORIGIN: 'https://app.example.com',
    });
    expect(error?.message).toContain('生产环境必须显式配置 JWT_SECRET');
  });

  it('JWT_SECRET 使用示例/占位密钥在生产被拒绝（长度达标也拦不住占位符）', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      // docker/.env.prod.example 的占位符本身有 41 字符，min(16) 会放行
      JWT_SECRET: 'change_me_random_secret_at_least_16_chars',
      DB_PASSWORD: 's3cret',
      REDIS_PASSWORD: 'r3dis',
      TRUST_PROXY: 'false',
      CORS_ORIGIN: 'https://app.example.com',
    });
    expect(error?.message).toContain(
      'JWT_SECRET 使用了示例/占位密钥（change_me / dev-only-secret）',
    );
  });

  it('JWT 开发兜底密钥在生产同样被拒（dev-only-secret 黑名单）', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      JWT_SECRET: 'dev-only-secret-change-me',
      DB_PASSWORD: 's3cret',
      REDIS_PASSWORD: 'r3dis',
      TRUST_PROXY: 'false',
      CORS_ORIGIN: 'https://app.example.com',
    });
    expect(error?.message).toContain('JWT_SECRET 使用了示例/占位密钥');
  });

  it('JWT_ACCESS_TTL 不小于 JWT_REFRESH_TTL 被拒绝（access 必须显著短于 refresh）', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      JWT_SECRET: 'prod-secret-0123456789abcdef',
      JWT_ACCESS_TTL_SECONDS: '900',
      JWT_REFRESH_TTL_SECONDS: '900', // 相等：access 形同 refresh
    });
    expect(error?.message).toContain(
      'JWT_ACCESS_TTL_SECONDS 必须小于 JWT_REFRESH_TTL_SECONDS',
    );
  });

  it('JWT_ACCESS_TTL 倒挂（大于 refresh）被拒绝', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      JWT_SECRET: 'prod-secret-0123456789abcdef',
      JWT_ACCESS_TTL_SECONDS: '604800',
      JWT_REFRESH_TTL_SECONDS: '900',
    });
    expect(error?.message).toContain('JWT_ACCESS_TTL_SECONDS 必须小于');
  });

  it('生产环境缺少 TRUST_PROXY 被拒绝（防伪造 X-Forwarded-For）', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      DB_PASSWORD: 's3cret',
      REDIS_PASSWORD: 'r3dis',
      CORS_ORIGIN: 'https://app.example.com',
    });
    expect(error?.message).toContain('生产环境必须显式配置 TRUST_PROXY');
  });

  it('生产环境缺少 CORS_ORIGIN 被拒绝（不允许默认通配 * 静默上线）', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      DB_PASSWORD: 's3cret',
      REDIS_PASSWORD: 'r3dis',
      TRUST_PROXY: 'false',
    });
    expect(error?.message).toContain('生产环境必须显式配置 CORS_ORIGIN');
  });

  it('生产环境缺少 DB_PASSWORD / REDIS_PASSWORD 被拒绝', () => {
    const missing = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      REDIS_PASSWORD: 'r3dis',
      TRUST_PROXY: 'false',
      CORS_ORIGIN: 'https://app.example.com',
    });
    expect(missing.error?.message).toContain(
      '生产环境必须显式配置 DB_PASSWORD',
    );

    const noRedis = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      DB_PASSWORD: 's3cret',
      TRUST_PROXY: 'false',
      CORS_ORIGIN: 'https://app.example.com',
    });
    expect(noRedis.error?.message).toContain(
      '生产环境必须显式配置 REDIS_PASSWORD',
    );
  });

  it('生产环境 DB_SYNCHRONIZE=true 被拒绝', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      NODE_ENV: 'production',
      DB_SYNCHRONIZE: 'true',
    });
    expect(error?.message).toContain('生产环境禁止 DB_SYNCHRONIZE=true');
  });

  it('DB_POOL_MIN 大于 DB_POOL_MAX 被拒绝', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      DB_POOL_MIN: '20',
      DB_POOL_MAX: '10',
    });
    expect(error?.message).toContain('DB_POOL_MIN 不能大于 DB_POOL_MAX');
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

  describe('驱动级超时顺序（statement < query，任一为 0 跳过比较）', () => {
    it('反向配置（query=3000, statement=8000）被拒绝', () => {
      const { error } = envValidationSchema.validate({
        ...validEnv,
        DB_QUERY_TIMEOUT_MS: '3000',
        DB_STATEMENT_TIMEOUT_MS: '8000',
      });
      expect(error?.message).toContain('DB_STATEMENT_TIMEOUT_MS 必须小于');
    });

    it('相等配置被拒绝', () => {
      const { error } = envValidationSchema.validate({
        ...validEnv,
        DB_QUERY_TIMEOUT_MS: '5000',
        DB_STATEMENT_TIMEOUT_MS: '5000',
      });
      expect(error?.message).toContain('DB_STATEMENT_TIMEOUT_MS 必须小于');
    });

    it('单侧为零（禁用）跳过比较', () => {
      const queryDisabled = envValidationSchema.validate({
        ...validEnv,
        DB_QUERY_TIMEOUT_MS: '0',
        DB_STATEMENT_TIMEOUT_MS: '8000',
      });
      expect(queryDisabled.error).toBeUndefined();

      const statementDisabled = envValidationSchema.validate({
        ...validEnv,
        DB_QUERY_TIMEOUT_MS: '5000',
        DB_STATEMENT_TIMEOUT_MS: '0',
      });
      expect(statementDisabled.error).toBeUndefined();
    });

    it('合法顺序（query=5000, statement=4000）通过', () => {
      const { error } = envValidationSchema.validate({
        ...validEnv,
        DB_QUERY_TIMEOUT_MS: '5000',
        DB_STATEMENT_TIMEOUT_MS: '4000',
      });
      expect(error).toBeUndefined();
    });

    describe('TRUST_PROXY 跳数上界', () => {
      it.each([
        ['11', '11'], // 超过 10 层的跳数配置（多层代理极端罕见，无界信任任意 XFF）
        ['999', '999'],
        ['abc', 'abc'], // 非数字/布尔值
        ['', ''],
      ])('非法值 %j 被拒绝（防无界信任 X-Forwarded-For）', (raw) => {
        const { error } = envValidationSchema.validate({
          ...validEnv,
          TRUST_PROXY: raw,
        });
        expect(error).toBeDefined();
        expect(error?.details.some((d) => d.path.includes('TRUST_PROXY'))).toBe(
          true,
        );
      });

      it.each(['false', 'true', '0', '3', '10'])(
        '合法值 %j 通过（0-10 跳数 + true/false）',
        (raw) => {
          const { error } = envValidationSchema.validate({
            ...validEnv,
            TRUST_PROXY: raw,
          });
          expect(error).toBeUndefined();
        },
      );
    });

    it('超出 PG 毫秒 GUC 上界（int32 max）被拒绝', () => {
      const { error } = envValidationSchema.validate({
        ...validEnv,
        DB_QUERY_TIMEOUT_MS: '2147483648',
      });
      expect(error).toBeDefined();
      expect(
        error?.details.some((d) => d.path.includes('DB_QUERY_TIMEOUT_MS')),
      ).toBe(true);
    });

    it('上界值本身通过', () => {
      const { error } = envValidationSchema.validate({
        ...validEnv,
        DB_QUERY_TIMEOUT_MS: '2147483647',
        DB_STATEMENT_TIMEOUT_MS: '2147483646',
      });
      expect(error).toBeUndefined();
    });
  });
});
