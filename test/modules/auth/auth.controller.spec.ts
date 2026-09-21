import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { AuthController } from '@/modules/auth/auth.controller';
import { AuthService } from '@/modules/auth/auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  // 独立 const 的 mock：直接引用函数断言，避免 unbound-method 误报
  const register = jest.fn();
  const login = jest.fn();
  const refresh = jest.fn();
  const logout = jest.fn();
  const me = jest.fn();
  const getOrThrow = jest.fn();

  const makeRes = () => {
    // cookie/clearCookie 独立 const：断言函数本身，避免 unbound-method 误报
    const cookie = jest.fn();
    const clearCookie = jest.fn();
    return {
      res: { cookie, clearCookie } as unknown as Response,
      cookie,
      clearCookie,
    };
  };

  const makeReq = (overrides: Partial<Request> = {}) =>
    ({
      headers: { 'user-agent': 'test-agent', 'x-forwarded-for': '1.2.3.4' },
      cookies: {},
      ip: '9.9.9.9',
      ...overrides,
    }) as Request;

  beforeEach(() => {
    getOrThrow.mockImplementation((key: string): unknown =>
      key === 'jwt'
        ? { secret: 's', accessTtlSeconds: 900, refreshTtlSeconds: 604800 }
        : key === 'app'
          ? { env: 'test', prefix: 'api' }
          : undefined,
    );
    controller = new AuthController(
      {
        register,
        login,
        refresh,
        logout,
        me,
      } as unknown as AuthService,
      { getOrThrow } as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('登录：透传 DTO/IP/UA 给 service，并写 httpOnly refresh Cookie（Path 覆盖整个认证前缀）', async () => {
    const pair = {
      accessToken: 'at',
      refreshToken: 'rt'.padEnd(64, 'f'),
      user: { id: '1' },
    };
    login.mockResolvedValue(pair);
    const { res, cookie } = makeRes();

    const result = await controller.login(
      { account: 'alice', password: 'secret123' },
      makeReq(),
      res,
    );

    expect(login).toHaveBeenCalledWith(
      { account: 'alice', password: 'secret123' },
      '9.9.9.9', // 直接取 req.ip（已按 TRUST_PROXY 解析），不再读原始 X-Forwarded-For
      'test-agent',
    );
    expect(cookie).toHaveBeenCalledWith(
      'refresh_token',
      pair.refreshToken,
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        // Path 必须覆盖 /logout（否则浏览器登出不带 Cookie，服务端撤销失效）
        path: '/api/auth',
        maxAge: 604800 * 1000,
      }),
    );
    expect(result).toBe(pair);
  });

  it('登录：忽略原始 X-Forwarded-For，只用 req.ip（直连部署防伪造）', async () => {
    login.mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'x'.repeat(64),
      user: { id: '1' },
    });
    const { res } = makeRes();
    await controller.login(
      { account: 'alice', password: 'p' },
      // headers 里伪造了 XFF，但 TRUST_PROXY=false 时 req.ip 才是权威来源
      makeReq({
        headers: { 'user-agent': 'ua', 'x-forwarded-for': '6.6.6.6' },
      }),
      res,
    );
    expect(login).toHaveBeenCalledWith(expect.anything(), '9.9.9.9', 'ua');
  });

  it('刷新：Cookie 缺失且 body 缺失 → 401（刷新必须有令牌）', async () => {
    const { res } = makeRes();
    await expect(controller.refresh({}, makeReq(), res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('刷新：Cookie 优先于 body（移动端才用 body 兜底）', async () => {
    const pair = {
      accessToken: 'at',
      refreshToken: 'r'.repeat(64),
      user: { id: '1' },
    };
    refresh.mockResolvedValue(pair);
    const { res, cookie } = makeRes();
    await controller.refresh(
      { refreshToken: 'body-token' },
      makeReq({ cookies: { refresh_token: 'cookie-token' } }),
      res,
    );
    expect(refresh).toHaveBeenCalledWith(
      'cookie-token',
      '9.9.9.9',
      'test-agent',
    );
    expect(cookie).toHaveBeenCalled(); // 轮换后重写新 Cookie
  });

  it('刷新：Cookie 为空串（refresh_token=）→ 回退 body 令牌（空串不是有效令牌）', async () => {
    const pair = {
      accessToken: 'at',
      refreshToken: 'r'.repeat(64),
      user: { id: '1' },
    };
    refresh.mockResolvedValue(pair);
    const { res } = makeRes();
    await controller.refresh(
      { refreshToken: 'body-token' },
      // 浏览器可能发送空的 refresh_token Cookie：typeof 判断会把空串当"已携带"，
      // 导致合法 body 令牌被忽略（刷新被拒、登出静默失效）——必须回退 body
      makeReq({ cookies: { refresh_token: '' } }),
      res,
    );
    expect(refresh).toHaveBeenCalledWith('body-token', '9.9.9.9', 'test-agent');
  });

  it('登出：撤销令牌 + 清除 Cookie', async () => {
    const { res, clearCookie } = makeRes();
    await controller.logout(
      {},
      makeReq({ cookies: { refresh_token: 't' } }),
      res,
    );
    expect(logout).toHaveBeenCalledWith('t');
    expect(clearCookie).toHaveBeenCalledWith(
      'refresh_token',
      expect.objectContaining({ path: '/api/auth' }),
    );
  });

  it('me：把守卫注入的 user.id 传给 service', async () => {
    me.mockResolvedValue({ id: '42' });
    await controller.me({ user: { id: '42' } } as never);
    expect(me).toHaveBeenCalledWith('42');
  });
});
