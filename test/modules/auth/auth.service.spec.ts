import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare, hash } from 'bcrypt';
import { PinoLogger } from 'nestjs-pino';
import {
  type DataSource,
  type DeepPartial,
  type FindOneOptions,
  FindOperator,
  type FindOptionsWhere,
  QueryFailedError,
  type Repository,
  type UpdateResult,
} from 'typeorm';

import { AuthService } from '@/modules/auth/auth.service';
import { RefreshToken } from '@/modules/auth/entities/refresh-token.entity';
import { User } from '@/modules/auth/entities/user.entity';
import { Permission } from '@/modules/rbac/entities/permission.entity';

// bcrypt 计算昂贵且耗时不可控，单测中 mock 为确定性实现。
// 用 jest.Mock 而非 jest.MockedFunction：bcrypt 的泛型/重载会让
// mockResolvedValue 推断成 never（ts-jest 类型检查会报错）
jest.mock('bcrypt', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));

const mockedHash = hash as jest.Mock;
const mockedCompare = compare as jest.Mock;

// 显式非泛型签名：Repository.save<T> 是泛型方法，jest.Mocked 会把
// mockResolvedValue 的参数推断为 never；这里固定 DeepPartial → Entity
// 使 mock 返回类型可赋值（tsc --noEmit 全量类型闸门的一部分）
type UserRepo = {
  findOne: (options: FindOneOptions<User>) => Promise<User | null>;
  findOneBy: (where: FindOptionsWhere<User>) => Promise<User | null>;
  save: (entity: DeepPartial<User>) => Promise<User>;
  create: (entity: DeepPartial<User>) => User;
};
type TokenRepo = {
  findOneBy: (
    where: FindOptionsWhere<RefreshToken>,
  ) => Promise<RefreshToken | null>;
  save: (entity: DeepPartial<RefreshToken>) => Promise<RefreshToken>;
  create: (entity: DeepPartial<RefreshToken>) => RefreshToken;
  update: (
    criteria: string | FindOptionsWhere<RefreshToken>,
    partial: DeepPartial<RefreshToken>,
  ) => Promise<UpdateResult>;
};

describe('AuthService', () => {
  let service: AuthService;
  let users: jest.Mocked<UserRepo>;
  let refreshTokens: jest.Mocked<TokenRepo>;
  let permissions: { find: jest.Mock };
  let jwtService: { signAsync: jest.Mock };
  let configService: { getOrThrow: jest.Mock };
  let logger: { info: jest.Mock; warn: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let managerRepo: jest.Mocked<TokenRepo>;

  /** 构造一个合法的 User 样本（仅测试用，不触发数据库） */
  const makeUser = (overrides: Partial<User> = {}): User => ({
    id: '1',
    username: 'alice',
    email: 'alice@example.com',
    phone: null,
    passwordHash: 'hashed:secret123',
    nickname: null,
    realName: null,
    gender: null,
    birthDate: null,
    avatarUrl: null,
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    status: 'active',
    sessionVersion: 0,
    roles: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    remark: null,
    deletedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    users = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    };
    refreshTokens = {
      findOneBy: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    permissions = { find: jest.fn() };
    jwtService = { signAsync: jest.fn() };
    configService = {
      getOrThrow: jest.fn((key: string): unknown =>
        key === 'jwt'
          ? {
              secret: 'test-secret',
              accessTtlSeconds: 900,
              refreshTtlSeconds: 604800,
            }
          : undefined,
      ),
    };
    logger = { info: jest.fn(), warn: jest.fn() };
    // 事务 mock：manager 用独立的仓库 mock（与默认仓库 refreshTokens 区分）——
    // 事务内的 update/save/create 必须走 manager（绑定事务连接）；若实现误用
    // this.refreshTokens（默认连接，不受事务保护，会立即提交），断言会直接失败
    managerRepo = {
      findOneBy: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(async (fn: (m: unknown) => Promise<unknown>) =>
        fn({ getRepository: () => managerRepo }),
      ),
    };

    service = new AuthService(
      users as unknown as Repository<User>,
      refreshTokens as unknown as Repository<RefreshToken>,
      permissions as unknown as Repository<Permission>,
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
      logger as unknown as PinoLogger,
      dataSource as unknown as DataSource,
    );

    // admin 旁路会查全量权限码：默认空数组，具体用例按需覆盖
    permissions.find.mockResolvedValue([]);
    mockedHash.mockResolvedValue('hashed:secret123');
    mockedCompare.mockResolvedValue(true);
    jwtService.signAsync.mockResolvedValue('signed-access-token');
    refreshTokens.create.mockImplementation((v) => v as RefreshToken);
    users.create.mockImplementation((v) => v as User);
  });

  describe('register', () => {
    it('成功：bcrypt 哈希密码入库，邮箱小写规范化，返回不含敏感字段的用户', async () => {
      users.findOne.mockResolvedValue(null);
      users.save.mockResolvedValue(makeUser());

      await service.register({
        username: 'alice',
        password: 'secret123',
        email: 'Alice@Example.COM', // 大小写混合：入库前必须小写化
      });

      expect(mockedHash).toHaveBeenCalledWith('secret123', 10);
      expect(users.save).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'alice',
          email: 'alice@example.com',
          phone: null,
          passwordHash: 'hashed:secret123',
        }),
      );
    });

    it('手机号入库前去分隔符', async () => {
      users.findOne.mockResolvedValue(null);
      users.save.mockResolvedValue(makeUser());
      await service.register({
        username: 'bob',
        password: 'secret123',
        phone: '+86 138-0013-8000',
      });
      expect(users.save).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '+8613800138000' }),
      );
    });

    it('用户名已占用：抛出 409', async () => {
      users.findOne.mockResolvedValue(makeUser());
      await expect(
        service.register({ username: 'alice', password: 'secret123' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('软删行不占用标识（deletedAt 非空视为可复用）', async () => {
      users.findOne.mockResolvedValue(makeUser({ deletedAt: new Date() }));
      users.save.mockResolvedValue(makeUser());
      await expect(
        service.register({ username: 'alice', password: 'secret123' }),
      ).resolves.toBeUndefined(); // 注册不返回用户信息（/me 是唯一资料入口）
    });

    it('唯一索引冲突（并发/竞态 23505）映射为 409 而非 500', async () => {
      users.findOne.mockResolvedValue(null);
      const driverError = Object.assign(new Error('duplicate key'), {
        code: '23505',
      });
      users.save.mockRejectedValue(
        new QueryFailedError('INSERT INTO users', [], driverError),
      );
      await expect(
        service.register({ username: 'alice', password: 'secret123' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('密码超过 72 字节（bcrypt 截断上限）被拒绝', async () => {
      await expect(
        service.register({ username: 'alice', password: '密'.repeat(73) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('login', () => {
    it('成功：签发访问令牌 + refresh token 落库（哈希 + 未来过期时间 + IP 截断 45）', async () => {
      users.findOne.mockResolvedValue(makeUser());
      refreshTokens.save.mockResolvedValue({} as RefreshToken);

      const result = await service.login(
        { account: 'alice', password: 'secret123' },
        'x'.repeat(200), // 超长 IP：写库前必须截断到 varchar(45)
        'test-agent',
      );

      expect(jwtService.signAsync).toHaveBeenCalledWith({ sub: '1' });
      expect(result.accessToken).toBe('signed-access-token');
      expect(result.refreshToken).toMatch(/^[0-9a-f]{64}$/);
      const saved = refreshTokens.save.mock.calls[0][0] as RefreshToken;
      expect(saved.tokenHash).not.toBe(result.refreshToken);
      expect(saved.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(saved.userId).toBe('1');
      expect(saved.ip).toHaveLength(45); // 截断而非报错
      expect(saved.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('邮箱登录：查询侧 trim + 小写（与入库规范化对称；修复"只小写不 trim，带空格匹配不到"）', async () => {
      users.findOne.mockResolvedValue(makeUser());
      refreshTokens.save.mockResolvedValue({} as RefreshToken);
      await service.login(
        { account: ' Alice@Example.COM ', password: 'secret123' }, // 带空格 + 大小写混合
        'ip',
        'ua',
      );
      // 单字段查询（形态路由）：不再 OR 跨命名空间匹配
      expect(users.findOne.mock.calls[0][0].where).toEqual({
        email: 'alice@example.com',
      });
    });

    it('登录标识按形态路由：邮箱 → email 列；手机号 → phone 列（去分隔符）；其余 → username 列', async () => {
      // 邮箱形态
      await service
        .login({ account: 'alice@example.com', password: 'p' }, 'ip', 'ua')
        .catch(() => undefined);
      expect(users.findOne.mock.calls[0][0].where).toEqual({
        email: 'alice@example.com',
      });
      // 手机号形态（含 + 区号与分隔符）：单查 phone 列——若 A 的用户名恰为某数字、
      // B 的手机号也是它，OR 查询会命中两行且返回不可预期，单字段查询消除歧义
      await service
        .login({ account: '+86 138-0013-8000', password: 'p' }, 'ip', 'ua')
        .catch(() => undefined);
      expect(users.findOne.mock.calls[1][0].where).toEqual({
        phone: '+8613800138000',
      });
      // 普通用户名（含下划线等非数字字符）
      await service
        .login({ account: 'alice_01', password: 'p' }, 'ip', 'ua')
        .catch(() => undefined);
      expect(users.findOne.mock.calls[2][0].where).toEqual({
        username: 'alice_01',
      });
    });

    it('密码错误：统一"账号或密码错误"，且 compare 仍执行（恒时假比对）', async () => {
      users.findOne.mockResolvedValue(makeUser());
      mockedCompare.mockResolvedValue(false);
      await expect(
        service.login({ account: 'alice', password: 'wrong' }, 'ip', 'ua'),
      ).rejects.toMatchObject({
        response: { message: '账号或密码错误' },
      });
      expect(mockedCompare).toHaveBeenCalledWith('wrong', 'hashed:secret123');
      expect(logger.warn).toHaveBeenCalled();
    });

    it('账号不存在：同样返回统一消息，且对哑哈希执行 compare（防响应时长枚举）', async () => {
      users.findOne.mockResolvedValue(null);
      await expect(
        service.login({ account: 'nobody', password: 'secret123' }, 'ip', 'ua'),
      ).rejects.toMatchObject({
        response: { message: '账号或密码错误' },
      });
      // 关键断言：即便账号不存在也必须调用 compare（对固定哑哈希，$2b$ 前缀与
      // 原生 bcrypt 生成一致）
      expect(mockedCompare).toHaveBeenCalledWith(
        'secret123',
        expect.stringContaining('$2b$10$'),
      );
    });

    it('账号禁用：走业务码契约（HTTP 200 + bizCode），而非被 403 文案吞掉语义', async () => {
      users.findOne.mockResolvedValue(makeUser({ status: 'disabled' }));
      await expect(
        service.login({ account: 'alice', password: 'secret123' }, 'ip', 'ua'),
      ).rejects.toMatchObject({
        // BusinessException 契约：response 为纯业务文案，bizCode 为实例属性
        response: '账号已被禁用',
        bizCode: 10001,
      });
    });

    it('登录失败日志不落 PII 明文（邮箱脱敏）', async () => {
      users.findOne.mockResolvedValue(null);
      await service
        .login(
          { account: 'victim@example.com', password: 'secret123' },
          'ip',
          'ua',
        )
        .catch(() => undefined);
      const warnCall = logger.warn.mock.calls[0] as [{ account: string }];
      const warnPayload = warnCall[0];
      expect(warnPayload.account).not.toContain('victim@example.com');
      expect(warnPayload.account).toMatch(/^v\*\*\*@example\.com$/);
    });

    it('登录失败日志：带分隔符的手机号同样脱敏（先规范化再判定，不落 PII 明文）', async () => {
      users.findOne.mockResolvedValue(null);
      await service
        .login(
          { account: '+86 138-0013-8000', password: 'secret123' },
          'ip',
          'ua',
        )
        .catch(() => undefined);
      const warnCall = logger.warn.mock.calls[0] as [{ account: string }];
      const warnPayload = warnCall[0];
      expect(warnPayload.account).not.toContain('+86 138-0013-8000');
      // 规范化 '+8613800138000' → '+86****8000'（前 3 + 后 4）
      expect(warnPayload.account).toBe('+86****8000');
    });

    it('登录超长口令（>72 字节）：不抛 400（快速 400 泄露处理路径，破坏统一 401+恒时），先假比对再统一 401', async () => {
      users.findOne.mockResolvedValue(makeUser());
      await expect(
        service.login(
          { account: 'alice', password: '密'.repeat(73) },
          'ip',
          'ua',
        ),
      ).rejects.toMatchObject({ response: { message: '账号或密码错误' } });
      // 恒时保留：超长必然失败，但仍执行了一次 compare
      expect(mockedCompare).toHaveBeenCalled();
    });

    it('严重回归：passwordHash 为 NULL 的账号（第三方通道）即使口令是 DUMMY 明文 "password" 也拒绝', async () => {
      users.findOne.mockResolvedValue(makeUser({ passwordHash: null }));
      // 模拟真实 DUMMY 行为：bcrypt("password") 与 "password" 比对成功（用户实测确认）——
      // 若无 !user.passwordHash 显式拒绝，该账号会被固定口令放行
      mockedCompare.mockResolvedValue(true);
      await expect(
        service.login(
          { account: 'oauth-user', password: 'password' },
          'ip',
          'ua',
        ),
      ).rejects.toMatchObject({ response: { message: '账号或密码错误' } });
      // 恒时保留：仍对哑哈希执行了一次 compare
      expect(mockedCompare).toHaveBeenCalledWith(
        'password',
        expect.stringContaining('$2b$10$'),
      );
      expect(jwtService.signAsync).not.toHaveBeenCalled(); // 绝不签发令牌
    });
  });

  describe('refresh（轮换）', () => {
    const activeToken = () =>
      ({
        id: 'rt-1',
        userId: '1',
        tokenHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        ip: '127.0.0.1',
      }) as RefreshToken;

    it('成功：先校验用户状态，再在事务内 CAS 撤销旧令牌并签发新对', async () => {
      refreshTokens.findOneBy.mockResolvedValue(activeToken());
      // affected===1：update 必须恰好影响一行，轮换才继续
      managerRepo.update.mockResolvedValue({ affected: 1 } as UpdateResult);
      managerRepo.save.mockResolvedValue({} as RefreshToken);
      users.findOneBy.mockResolvedValue(makeUser());

      const before = Date.now();
      const result = await service.refresh('raw-token', 'ip', 'ua');

      // 撤销必须走 manager（事务连接）：默认仓库 refreshTokens 绑定独立连接，
      // 用它执行 UPDATE 会绕过事务立即提交（原子性形同虚设）——下面的
      // not.toHaveBeenCalled 断言就是钉这个陷阱
      const updateCall = managerRepo.update.mock.calls[0];
      const criteria = updateCall[0] as {
        id: string;
        revokedAt: FindOperator<Date>;
      };
      expect(criteria.id).toBe('rt-1');
      // 条件撤销：仅未撤销行可被轮换（CAS 的判定条件）
      expect(criteria.revokedAt).toBeInstanceOf(FindOperator);
      const patch = updateCall[1] as { revokedAt: Date };
      expect(patch.revokedAt).toBeInstanceOf(Date);
      expect(patch.revokedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(refreshTokens.update).not.toHaveBeenCalled();
      // 落库同样走 manager（事务内）；默认仓库不参与
      expect(managerRepo.save).toHaveBeenCalledTimes(1);
      expect(refreshTokens.save).not.toHaveBeenCalled();
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(jwtService.signAsync).toHaveBeenCalledWith({ sub: '1' });
      expect(result.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it('并发轮换 CAS：update 影响 0 行（已被并发请求撤销）→ 401 且不签发', async () => {
      refreshTokens.findOneBy.mockResolvedValue(activeToken());
      users.findOneBy.mockResolvedValue(makeUser());
      // 两个并发请求都通过前置检查，后到者 update 匹配不到 revokedAt IS NULL 的行
      managerRepo.update.mockResolvedValue({ affected: 0 } as UpdateResult);

      await expect(
        service.refresh('raw-token', 'ip', 'ua'),
      ).rejects.toMatchObject({
        // 标准 401 信封：error/message/statusCode（与"令牌无效"分支同一响应形状）
        response: { message: '刷新令牌无效或已过期', statusCode: 401 },
      });
      // 未签发新对、未落库新令牌——不会产生第二条有效会话
      expect(jwtService.signAsync).not.toHaveBeenCalled();
      expect(managerRepo.save).not.toHaveBeenCalled();
      expect(refreshTokens.save).not.toHaveBeenCalled();
    });

    it('轮换原子性：撤销成功但新令牌落库失败 → 异常传播（DB 抖动时整体回滚，旧令牌保持有效）', async () => {
      refreshTokens.findOneBy.mockResolvedValue(activeToken());
      users.findOneBy.mockResolvedValue(makeUser());
      managerRepo.update.mockResolvedValue({ affected: 1 } as UpdateResult);
      managerRepo.save.mockRejectedValue(new Error('db down'));

      await expect(service.refresh('raw-token', 'ip', 'ua')).rejects.toThrow(
        'db down',
      );
      // 撤销与落库都在 manager（事务连接）上：落库失败时事务整体失败，
      // 旧令牌的撤销随之回滚——客户端可重试刷新，而非"旧令牌已撤销、新令牌未落库"被迫重登
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(managerRepo.update).toHaveBeenCalledTimes(1);
      expect(managerRepo.save).toHaveBeenCalledTimes(1);
      expect(refreshTokens.update).not.toHaveBeenCalled();
      expect(refreshTokens.save).not.toHaveBeenCalled();
      expect(jwtService.signAsync).toHaveBeenCalledTimes(1); // 签发在事务体内已执行
    });

    it('用户已被禁用：刷新被拒绝，且不撤销/不签发（封禁账号无法续期）', async () => {
      refreshTokens.findOneBy.mockResolvedValue(activeToken());
      users.findOneBy.mockResolvedValue(makeUser({ status: 'disabled' }));

      await expect(
        service.refresh('raw-token', 'ip', 'ua'),
      ).rejects.toMatchObject({
        response: '账号已被禁用',
        bizCode: 10001,
      });
      // 关键：令牌落库前失败——不产生孤儿会话，也不轮换
      expect(refreshTokens.update).not.toHaveBeenCalled();
      expect(refreshTokens.save).not.toHaveBeenCalled();
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    });

    it('用户已删除：401 且不撤销（同无孤儿会话）', async () => {
      refreshTokens.findOneBy.mockResolvedValue(activeToken());
      users.findOneBy.mockResolvedValue(null);
      await expect(
        service.refresh('raw-token', 'ip', 'ua'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(refreshTokens.update).not.toHaveBeenCalled();
      expect(refreshTokens.save).not.toHaveBeenCalled();
    });

    it('已撤销的令牌：401（轮换后的旧令牌不可再用）', async () => {
      refreshTokens.findOneBy.mockResolvedValue({
        ...activeToken(),
        revokedAt: new Date(),
      });
      await expect(
        service.refresh('old-token', 'ip', 'ua'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('过期的令牌：401', async () => {
      refreshTokens.findOneBy.mockResolvedValue({
        ...activeToken(),
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(
        service.refresh('expired-token', 'ip', 'ua'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('令牌不存在：401', async () => {
      refreshTokens.findOneBy.mockResolvedValue(null);
      await expect(
        service.refresh('unknown', 'ip', 'ua'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('logout / me', () => {
    it('登出：按哈希撤销令牌，且只撤销未撤销过的行（不重写首次撤销时间）', async () => {
      refreshTokens.update.mockResolvedValue({} as UpdateResult);
      await service.logout('raw-token');
      const [criteria] = refreshTokens.update.mock.calls[0];
      const where = criteria as { tokenHash: string; revokedAt: unknown };
      expect(where.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // revokedAt: IsNull() —— 已撤销令牌不再命中，重复登出不把撤销时间往后刷
      expect(where.revokedAt).toBeInstanceOf(FindOperator);
      const patch = refreshTokens.update.mock.calls[0][1] as {
        revokedAt: Date;
      };
      expect(patch.revokedAt).toBeInstanceOf(Date);
    });

    it('登出：无令牌时幂等（不调用撤销）', async () => {
      await service.logout(undefined);
      expect(refreshTokens.update).not.toHaveBeenCalled();
    });

    it('me：返回安全字段 + RBAC 角色/权限', async () => {
      // me 现在用 findOne（带 roles.permissions 关系加载），findOneBy 不再被调用
      users.findOne.mockResolvedValue(
        makeUser({
          roles: [
            {
              id: '1',
              code: 'admin',
              name: 'x',
              isSystem: true,
              permissions: [],
              createdAt: new Date(),
              updatedAt: new Date(),
              deletedAt: null,
              users: [],
              description: null,
            },
          ],
        }),
      );
      const result = await service.me('1');
      expect(result.id).toBe('1');
      expect(result).not.toHaveProperty('passwordHash');
      expect(result.roles).toContain('admin');
    });

    it('me：普通角色返回权限码并集（去重）', async () => {
      users.findOne.mockResolvedValue(
        makeUser({
          roles: [
            {
              id: '2',
              code: 'editor',
              name: 'x',
              isSystem: false,
              permissions: [
                {
                  id: '1',
                  code: 'user:read',
                  name: 'x',
                  group: null,
                  description: null,
                  createdAt: new Date(),
                  roles: [],
                },
                {
                  id: '2',
                  code: 'user:delete',
                  name: 'x',
                  group: null,
                  description: null,
                  createdAt: new Date(),
                  roles: [],
                },
              ],
              createdAt: new Date(),
              updatedAt: new Date(),
              deletedAt: null,
              users: [],
              description: null,
            },
          ],
        }),
      );
      const result = await service.me('1');
      expect(result.roles).toEqual(['editor']);
      expect(result.permissions.sort()).toEqual(['user:delete', 'user:read']);
    });

    it('me：admin 角色返回全量权限码（旁路）', async () => {
      users.findOne.mockResolvedValue(
        makeUser({
          roles: [
            {
              id: '1',
              code: 'admin',
              name: 'x',
              isSystem: true,
              permissions: [],
              createdAt: new Date(),
              updatedAt: new Date(),
              deletedAt: null,
              users: [],
              description: null,
            },
          ],
        }),
      );
      permissions.find.mockResolvedValue([
        { code: 'user:read' },
        { code: 'user:delete' },
      ]);
      const result = await service.me('1');
      expect(result.roles).toEqual(['admin']);
      expect(result.permissions).toEqual(['user:read', 'user:delete']);
    });

    it('me：用户不存在（已被删除）→ 401', async () => {
      users.findOne.mockResolvedValue(null);
      await expect(service.me('999')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('updateMe：只落传入字段，返回最新资料（含 RBAC）', async () => {
      users.findOneBy.mockResolvedValue(makeUser({ nickname: '旧昵称' }));
      users.save.mockResolvedValue(makeUser({ nickname: '新昵称' }));
      // updateMe 内部重查（me 路径）：findOne 返回带 roles/permissions 的完整用户
      users.findOne.mockResolvedValue(makeUser({ nickname: '新昵称' }));
      const result = await service.updateMe('1', { nickname: '新昵称' });
      expect(users.save).toHaveBeenCalledWith(
        expect.objectContaining({ nickname: '新昵称' }),
      );
      expect(result.nickname).toBe('新昵称');
      expect(result.roles).toEqual([]);
    });

    it('updateMe：用户不存在 → 401', async () => {
      users.findOneBy.mockResolvedValue(null);
      await expect(
        service.updateMe('999', { nickname: 'x' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
