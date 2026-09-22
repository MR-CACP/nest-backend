import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Repository } from 'typeorm';

import { ROLES_KEY } from '@/common/decorators/rbac.decorator';
import { User } from '@/modules/auth/entities/user.entity';
import { JwtAuthGuard } from '@/modules/auth/jwt-auth.guard';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: { verifyAsync: jest.Mock };
  let users: { findOneBy: jest.Mock; findOne: jest.Mock };

  /** 默认活跃用户（id 与载荷 sub 一致） */
  const makeUser = (overrides: Partial<User> = {}) =>
    ({ id: '7', status: 'active', ...overrides }) as User;

  /** handler 带 @Roles 元数据 → needsRbac=true（预加载分支） */
  const rbacHandler = () => {
    const fn = jest.fn();
    Reflect.defineMetadata(ROLES_KEY, ['admin'], fn);
    return fn;
  };

  const makeContext = (authorization?: string, user?: unknown) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers: authorization ? { authorization } : {},
          user,
        }),
      }),
      // guard 按 handler 元数据（@Roles/@Permissions）决定是否预加载 RBAC 关系；
      // 无元数据 → needsRbac=false → 走 findOneBy 分支
      getHandler: () => jest.fn(),
      getClass: () => class {},
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    jwtService = { verifyAsync: jest.fn() };
    users = { findOneBy: jest.fn(), findOne: jest.fn() };
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
      getHandler: () => jest.fn(),
      getClass: () => class {},
    } as unknown as ExecutionContext;

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

  it('接口声明 @Roles：预加载 roles.permissions（findOne + relations）并挂 userEntity', async () => {
    jwtService.verifyAsync.mockResolvedValue({ sub: '7' });
    const userWithRbac = makeUser({
      roles: [{ id: 'r1', code: 'admin', permissions: [] }] as never,
    });
    users.findOne.mockResolvedValue(userWithRbac);
    const request: {
      headers?: { authorization?: string };
      user?: unknown;
      userEntity?: unknown;
    } = { headers: { authorization: 'Bearer valid' } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: rbacHandler,
      getClass: () => class {},
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // needsRbac=true → findOne + relations（预加载 RBAC 关系），不是 findOneBy
    expect(users.findOne).toHaveBeenCalledWith({
      where: { id: '7' },
      relations: { roles: { permissions: true } },
    });
    expect(users.findOneBy).not.toHaveBeenCalled();
    // 完整实体（含 roles.permissions）挂到 request.userEntity 供 RolesGuard 复用
    expect(request.userEntity).toBe(userWithRbac);
    expect(request.user).toEqual({ id: '7' });
  });

  it('载荷缺少 sub：401（携带 undefined 查库会退化为全表首行，属越权读取）', async () => {
    jwtService.verifyAsync.mockResolvedValue({});
    const request: { headers?: { authorization?: string }; user?: unknown } = {
      headers: { authorization: 'Bearer no-sub' },
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => jest.fn(),
      getClass: () => class {},
    } as unknown as ExecutionContext;
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
