import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Repository } from 'typeorm';

import { User } from '@/modules/auth/entities/user.entity';
import { JwtAuthGuard } from '@/modules/auth/jwt-auth.guard';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: { verifyAsync: jest.Mock };
  let users: { findOneBy: jest.Mock };

  /** 默认活跃用户（id 与载荷 sub 一致） */
  const makeUser = (overrides: Partial<User> = {}) =>
    ({ id: '7', status: 'active', ...overrides }) as User;

  const makeContext = (authorization?: string, user?: unknown) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers: authorization ? { authorization } : {},
          user,
        }),
      }),
    }) as ExecutionContext;

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    users = { findOneBy: jest.fn() };
    guard = new JwtAuthGuard(
      jwtService as unknown as JwtService,
      users as unknown as Repository<User>,
    );
  });

  it('合法 Bearer 令牌：解析 sub → 查库校验状态 → 挂到 request.user', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: '7' });
    users.findOneBy.mockResolvedValue(makeUser());
    const request: { headers?: { authorization?: string }; user?: unknown } = {
      headers: { authorization: 'Bearer valid.jwt.token' },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // 状态复查：按载荷 sub 查库（软删行被 findOneBy 默认过滤）
    expect(users.findOneBy).toHaveBeenCalledWith({ id: '7' });
    expect(request.user).toEqual({ id: '7' });
  });

  it('账号已被禁用：旧 access 令牌立即失效（即时封禁，不依赖 TTL 过期）', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: '7' });
    users.findOneBy.mockResolvedValue(makeUser({ status: 'disabled' }));
    await expect(
      guard.canActivate(makeContext('Bearer valid')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(users.findOneBy).toHaveBeenCalledWith({ id: '7' });
  });

  it('用户不存在（已删除）：401', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: '7' });
    users.findOneBy.mockResolvedValue(null);
    await expect(
      guard.canActivate(makeContext('Bearer valid')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('数据库故障（断连/超时）：原样抛出，不伪装成"登录已过期"（避免误导客户端刷新/清会话、掩盖服务故障）', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: '7' });
    users.findOneBy.mockRejectedValue(new Error('connection refused'));
    await expect(
      guard.canActivate(makeContext('Bearer valid')),
    ).rejects.toThrow('connection refused'); // 不是 UnauthorizedException
  });

  it('无 Authorization 头：401（不查库）', async () => {
    await expect(
      guard.canActivate(makeContext(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(users.findOneBy).not.toHaveBeenCalled();
  });

  it('非 Bearer 前缀：401', async () => {
    await expect(
      guard.canActivate(makeContext('Basic abc')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('令牌无效/过期：401', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));
    await expect(
      guard.canActivate(makeContext('Bearer invalid')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('载荷缺少 sub：401（携带 undefined 查库会退化为全表首行，属越权读取）', async () => {
    jwtService.verifyAsync.mockResolvedValue({});
    const request: { headers?: { authorization?: string }; user?: unknown } = {
      headers: { authorization: 'Bearer no-sub' },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.user).toBeUndefined();
    expect(users.findOneBy).not.toHaveBeenCalled();
  });

  it('载荷 sub 非字符串：401', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: 42 });
    await expect(
      guard.canActivate(makeContext('Bearer numeric-sub')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
