import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import {
  Permissions,
  PERMISSIONS_KEY,
  ROLES_KEY,
} from '@/common/decorators/rbac.decorator';
import { User } from '@/modules/auth/entities/user.entity';
import { Permission } from '@/modules/rbac/entities/permission.entity';
import { Role } from '@/modules/rbac/entities/role.entity';
import { RolesGuard } from '@/modules/rbac/roles.guard';

// 类级装饰器编译验证：@Permissions/@Roles 必须可直接用于控制器类——
// CustomDecorator 同时兼容 ClassDecorator 与 MethodDecorator；
// 若类型被收窄回 MethodDecorator，这里会直接编译报错（tsc 闸门拦下）。
@Permissions('user:read')
class ClassLevelController {}

/**
 * RolesGuard 单测：授权判定逻辑（不触数据库）。
 * 覆盖：无元数据放行 / 角色命中 / 权限命中 / admin 旁路 / 403 / DB 异常透传 /
 * 复用 JwtAuthGuard 已查的 userEntity（不二次查询）。
 */
describe('RolesGuard', () => {
  let guard: RolesGuard;
  let users: { findOne: jest.Mock };

  const makeRole = (code: string, permissionCodes: string[]): Role => ({
    id: '1',
    code,
    name: code,
    description: null,
    isSystem: false,
    permissions: permissionCodes.map((pc) => ({ code: pc }) as Permission),
    users: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });

  const makeUser = (roles: Role[]): User =>
    ({
      id: '1',
      username: 'alice',
      email: null,
      phone: null,
      passwordHash: 'hash',
      nickname: null,
      realName: null,
      gender: null,
      birthDate: null,
      avatarUrl: null,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      status: 'active',
      sessionVersion: 0,
      roles,
      createdAt: new Date(),
      updatedAt: new Date(),
      remark: null,
      deletedAt: null,
    }) as unknown as User;

  /** 构造最小 ExecutionContext：可设置方法级/类级 @Roles/@Permissions 元数据 */
  const makeContext = (
    request: { user: { id: string }; userEntity?: User },
    metadata: { roles?: string[]; permissions?: string[] },
    classMetadata?: { roles?: string[]; permissions?: string[] },
  ): ExecutionContext => {
    const handler = jest.fn();
    if (metadata.roles)
      Reflect.defineMetadata(ROLES_KEY, metadata.roles, handler);
    if (metadata.permissions)
      Reflect.defineMetadata(PERMISSIONS_KEY, metadata.permissions, handler);
    // 类级声明挂在控制器类构造函数上（context.getClass()）——不是 handler.constructor
    class DemoController {}
    if (classMetadata?.roles)
      Reflect.defineMetadata(ROLES_KEY, classMetadata.roles, DemoController);
    if (classMetadata?.permissions)
      Reflect.defineMetadata(
        PERMISSIONS_KEY,
        classMetadata.permissions,
        DemoController,
      );
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
      getClass: () => DemoController,
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    // 直接实例化：RolesGuard 只依赖 Repository<User>，无需加载 TypeOrmModule
    //（forFeature 的实体仓库依赖 DataSource，单测环境没有 TypeOrmModule.forRoot）
    users = { findOne: jest.fn() };
    guard = new RolesGuard(users as never);
  });

  it('无 @Roles/@Permissions 元数据：登录即可访问（不查库）', async () => {
    const ctx = makeContext(
      { user: { id: '1' }, userEntity: makeUser([]) },
      {},
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(users.findOne).not.toHaveBeenCalled();
  });

  it('@Roles 命中（用户有该角色）→ 放行', async () => {
    const ctx = makeContext(
      { user: { id: '1' }, userEntity: makeUser([makeRole('admin', [])]) },
      { roles: ['admin'] },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('@Roles 未命中 → 403', async () => {
    const ctx = makeContext(
      { user: { id: '1' }, userEntity: makeUser([makeRole('user', [])]) },
      { roles: ['admin'] },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('@Permissions 命中（角色绑定了该权限）→ 放行', async () => {
    const ctx = makeContext(
      {
        user: { id: '1' },
        userEntity: makeUser([makeRole('editor', ['user:read'])]),
      },
      { permissions: ['user:read'] },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('@Permissions 未命中 → 403', async () => {
    const ctx = makeContext(
      {
        user: { id: '1' },
        userEntity: makeUser([makeRole('editor', ['user:read'])]),
      },
      { permissions: ['user:delete'] },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('admin 旁路：拥有 admin 角色即放行，即使权限绑定为空（新权限点自动拥有）', async () => {
    const ctx = makeContext(
      { user: { id: '1' }, userEntity: makeUser([makeRole('admin', [])]) },
      { permissions: ['user:delete'] },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('复用 request.userEntity：携带时不再二次查询用户', async () => {
    const ctx = makeContext(
      { user: { id: '1' }, userEntity: makeUser([makeRole('admin', [])]) },
      { roles: ['admin'] },
    );
    await guard.canActivate(ctx);
    expect(users.findOne).not.toHaveBeenCalled();
  });

  it('类级 @Permissions 兜底：方法级无声明时读控制器类声明（不静默失效）', async () => {
    // 方法级无元数据，类级声明 user:read；editor 绑定该权限 → 放行
    const ctx = makeContext(
      {
        user: { id: '1' },
        userEntity: makeUser([makeRole('editor', ['user:read'])]),
      },
      {},
      { permissions: ['user:read'] },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('类级装饰器真实用法：@Permissions 直接用于类（类型兼容 + 运行时兜底）', async () => {
    const handler = jest.fn();
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: { id: '1' },
          userEntity: makeUser([makeRole('editor', ['user:read'])]),
        }),
      }),
      getHandler: () => handler,
      getClass: () => ClassLevelController,
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('方法级优先于类级：方法级声明覆盖类级', async () => {
    // 方法级要求 user:delete（editor 无）、类级 user:read（editor 有）→ 方法级优先 → 403
    const ctx = makeContext(
      {
        user: { id: '1' },
        userEntity: makeUser([makeRole('editor', ['user:read'])]),
      },
      { permissions: ['user:delete'] },
      { permissions: ['user:read'] },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('未携带 userEntity 时自行查询（防御性兜底）', async () => {
    users.findOne.mockResolvedValue(makeUser([makeRole('admin', [])]));
    const ctx = makeContext({ user: { id: '1' } }, { roles: ['admin'] });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(users.findOne).toHaveBeenCalled();
  });

  it('DB 异常原样透传（不伪装成 403/401）', async () => {
    users.findOne.mockRejectedValue(new Error('connection refused'));
    const ctx = makeContext({ user: { id: '1' } }, { roles: ['admin'] });
    await expect(guard.canActivate(ctx)).rejects.toThrow('connection refused');
  });
});
