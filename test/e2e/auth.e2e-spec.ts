import { createHash } from 'node:crypto';

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { IsNull, type Repository } from 'typeorm';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { RefreshToken } from '../../src/modules/auth/entities/refresh-token.entity';
import { User } from '../../src/modules/auth/entities/user.entity';

/**
 * 认证接口 e2e：真实 PostgreSQL + 迁移后的 schema，覆盖
 * 注册 → 登录 → /me → 刷新（轮换）→ 登出 → 旧令牌失效 全链路。
 * 注意限速预算：register/login 各 5 次/分钟、refresh 10 次/分钟（@Throttle），
 * 用例按序执行且调用次数均在预算内。
 */
describe('认证接口 (e2e)', () => {
  let app: INestApplication<App>;
  // 唯一用户名：test 库持久化，避免重复运行相互污染
  const suffix = Date.now().toString(36);
  const username = `e2e_${suffix}`;
  const password = 'secret123';

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const register = (user: string, pwd: string) =>
    request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ username: user, password: pwd });

  const login = (account: string, pwd: string) =>
    request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account, password: pwd });

  /** 从响应头提取 refresh_token Cookie 值（不含属性） */
  const extractCookie = (res: request.Response): string | undefined =>
    (res.headers['set-cookie'] as unknown as string[] | undefined)
      ?.find((c) => c.startsWith('refresh_token='))
      ?.split(';')[0];

  it('注册 → 登录 → /me → 刷新轮换，全链路（登出见下条用例）', async () => {
    // 注册：201 + 统一信封，data 为安全用户信息
    const reg = await register(username, password).expect(201);
    const regBody = reg.body as { code: number; data?: unknown };
    expect(regBody.code).toBe(0);
    // 注册刻意不返回用户信息（/me 是唯一资料入口）：data 为空
    expect(regBody.data).toBeUndefined();

    // 重复注册：409
    await register(username, password).expect(409);

    // 密码错误：401（响应层统一文案防枚举；细粒度原因只进服务端日志）
    const badLogin = await login(username, 'wrong-pass').expect(401);
    expect((badLogin.body as { message: string }).message).toBe(
      '未登录或登录已失效',
    );

    // 登录成功：令牌对 + httpOnly Cookie
    const ok = await login(username, password).expect(200);
    const loginBody = ok.body as {
      code: number;
      data: { accessToken: string; refreshToken: string };
    };
    expect(loginBody.code).toBe(0);
    expect(loginBody.data.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/); // JWT 三段
    expect(loginBody.data.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    const firstCookie = extractCookie(ok);
    expect(firstCookie).toMatch(/^refresh_token=.+/);
    expect(ok.headers['set-cookie'] as unknown as string[]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('HttpOnly'),
        // Path 覆盖整个 /api/auth：收窄到 /refresh 会让浏览器登出时不带 Cookie
        expect.stringContaining('Path=/api/auth'),
      ]),
    );

    // /me：Bearer 访问令牌（登录响应不含用户信息，这里用 username 校验身份）
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${loginBody.data.accessToken}`)
      .expect(200);
    expect((me.body as { data: { username: string } }).data.username).toBe(
      username,
    );

    // /me 无令牌：401
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);

    // 刷新（body 传 refresh）：轮换出新对
    const refreshed = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: loginBody.data.refreshToken })
      .expect(200);
    const refreshBody = refreshed.body as {
      data: { accessToken: string; refreshToken: string };
    };
    expect(refreshBody.data.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    // 轮换成功：新 refresh token 明文与旧的不同（access token 载荷仅 sub+iat，
    // 同一秒签发可能相同，不据此断言）
    expect(refreshBody.data.refreshToken).not.toBe(loginBody.data.refreshToken);

    // 旧 refresh token 已被撤销：再次刷新 401
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: loginBody.data.refreshToken })
      .expect(401);

    // 刷新（Cookie 传 refresh）：Cookie 路径同样生效（轮换出新对）
    const cookieRefresh = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', `refresh_token=${refreshBody.data.refreshToken}`)
      .expect(200);
    const cookieBody = cookieRefresh.body as {
      data: { refreshToken: string };
    };
    expect(cookieBody.data.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    expect(cookieBody.data.refreshToken).not.toBe(
      refreshBody.data.refreshToken,
    );
  });

  it('登出：Cookie 撤销 → 旧令牌 401 → 幂等登出不重写撤销时间（独立注册，不依赖其他用例）', async () => {
    const u = `e2e_logout_${suffix}`;
    await register(u, password).expect(201);
    const loginRes = await login(u, password).expect(200);
    const currentRt = (loginRes.body as { data: { refreshToken: string } }).data
      .refreshToken;

    // 登出（只带 Cookie 头、body 无令牌——supertest 手工塞头不做 Path 匹配，
    // Cookie 能被 /logout 携带由主链路 set-cookie 的 Path=/api/auth 断言证明）：
    // 服务端撤销令牌，而非仅清客户端 Cookie
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', `refresh_token=${currentRt}`)
      .expect(200);

    // 记录首次撤销时间（审计锚点）；DB 只存哈希，用 SHA-256 反查
    const tokensRepo = app.get<Repository<RefreshToken>>(
      getRepositoryToken(RefreshToken),
    );
    const tokenHash = createHash('sha256').update(currentRt).digest('hex');
    const revokedAfterFirst = await tokensRepo.findOneBy({ tokenHash });

    // 登出后该 token 再刷新：401（证明服务端状态已撤销，而非仅清客户端 Cookie）
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: currentRt })
      .expect(401);

    // 登出幂等：同一 token 再登出（body 方式）仍 200
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .send({ refreshToken: currentRt })
      .expect(200);

    // 关键断言：重复登出不重写首次撤销时间（logout 的 update 带 revokedAt IS NULL）——
    // 否则审计记录里"真正登出时刻"会被幂等请求刷成更晚的时间
    const revokedAfterSecond = await tokensRepo.findOneBy({ tokenHash });
    expect(revokedAfterFirst?.revokedAt).toBeInstanceOf(Date);
    expect(revokedAfterSecond?.revokedAt?.getTime()).toBe(
      revokedAfterFirst?.revokedAt?.getTime(),
    );
  });

  it('软删用户释放标识：同 username 重新注册成功，旧行保留（局部唯一索引钉住）', async () => {
    const usersRepo = app.get<Repository<User>>(getRepositoryToken(User));
    const u = `e2e_softdel_${suffix}`;

    // 首次注册成功
    await register(u, password).expect(201);

    // 模拟注销：走 TypeORM softDelete（真实注销路径；不依赖列名硬编码）
    await usersRepo.softDelete({ username: u });

    // 关键断言：同 username 重新注册必须 201——
    // 若唯一约束是普通 UNIQUE（无 WHERE deleted_at IS NULL），软删行仍占用标识，
    // 应用层 withDeleted 放行后 save 必被 PG 23505 打成 409，此用例即失败
    await register(u, password).expect(201);

    // 方案①的语义也要钉住：不是"复活"旧行，而是新注册——同 username 应有 2 行
    // （withDeleted: true：count 默认过滤软删行，这里要数含已删行的全量）
    const rowCount = await usersRepo.count({
      where: { username: u },
      withDeleted: true,
    });
    expect(rowCount).toBe(2);
  });

  it('并发刷新 CAS（真库）：同 token 并发刷新恰好一个 200 + 一个 401，且只留一条有效会话', async () => {
    const u = `e2e_cas_${suffix}`;
    await register(u, password).expect(201);
    const loginRes = await login(u, password).expect(200);
    const loginBody = loginRes.body as {
      data: { refreshToken: string; accessToken: string };
    };
    const refreshToken = loginBody.data.refreshToken;
    // 登录响应不含用户信息：userId 经 /me 获取（带 access token 的受保护接口）
    const meRes = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${loginBody.data.accessToken}`)
      .expect(200);
    const userId = (meRes.body as { data: { id: string } }).data.id;

    // 两个并发请求共用同一 refresh token：前置 findOneBy 都会读到"未撤销"而通过，
    // 撤销是带 revoked_at IS NULL 的原子 UPDATE——PG 行锁串行化后，
    // 先撤销成功者 affected=1 续期，后到者 affected=0 → 401。
    // 无论请求到达顺序如何，断言恰好一个 200 + 一个 401。
    const [r1, r2] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken }),
      request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);

    // 会话数：旧令牌已撤销 + 仅新令牌存活 → revoked_at IS NULL 的行数必须为 1，
    // 后到者不得签发第二条有效会话
    const tokensRepo = app.get<Repository<RefreshToken>>(
      getRepositoryToken(RefreshToken),
    );
    const activeCount = await tokensRepo.count({
      where: { userId, revokedAt: IsNull() },
    });
    expect(activeCount).toBe(1);
  });

  it('严重漏洞钉住（真库）：passwordHash 置 NULL 后固定口令 "password" 登录必须 401', async () => {
    const u = `e2e_nohash_${suffix}`;
    await register(u, password).expect(201);
    // 模拟第三方登录通道：密码哈希置 NULL（schema 为无密码账号预留）
    const usersRepo = app.get<Repository<User>>(getRepositoryToken(User));
    await usersRepo.update({ username: u }, { passwordHash: null });

    // 固定口令 "password"（DUMMY 的明文，compare 对哑哈希必然成功）——
    // !user.passwordHash 显式拒绝，绝不放行
    await login(u, 'password').expect(401);
    // 正常口令同样 401（账号已无有效凭证）
    await login(u, password).expect(401);
  });

  it('禁用账号 access 立即失效（guard 每请求复查 status，不依赖 TTL 过期）', async () => {
    const u = `e2e_ban_${suffix}`;
    await register(u, password).expect(201);
    const loginRes = await login(u, password).expect(200);
    const accessToken = (loginRes.body as { data: { accessToken: string } })
      .data.accessToken;

    // 禁用前：access 有效
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // 管理员禁用账号（管理端动作；此处直接改库）
    const usersRepo = app.get<Repository<User>>(getRepositoryToken(User));
    await usersRepo.update({ username: u }, { status: 'disabled' });

    // 禁用后：同一 access 令牌立即失效（guard 查库复查用户状态）
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);

    // 禁用后登录：业务码契约（HTTP 200 + code=10001 + X-Business-Code 头），
    // 前端可据此区分"凭据错误(401)"与"账号被禁(bizCode)"
    const banned = await login(u, password).expect(200);
    expect((banned.body as { code: number }).code).toBe(10001);
    expect(banned.headers['x-business-code']).toBe('10001');
  });

  it('超长密码（>72 字节）：HTTP 层不拦截（DTO 仅校验非空），服务层统一 401（防路径差异枚举）', async () => {
    const u = `e2e_longpw_${suffix}`;
    await register(u, password).expect(201);
    // 73 个 ASCII 字符 = 73 字节 > bcrypt 截断上限：必须走服务层恒时假比对 + 统一 401，
    // 而不是 HTTP 层提前 400（快速 400 会泄露处理路径差异，成为账号枚举通道）
    await login(u, 'x'.repeat(73)).expect(401);
  });

  it('注册 6-20 位纯数字用户名被拒（400）：否则会注册一个永远无法用用户名登录的账号（登录形态路由会当手机号查）', async () => {
    await register('1234567890', password).expect(400);
  });
});
