import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { type DataSource, FindOperator } from 'typeorm';

import { UsersService } from '@/modules/users/users.service';

// expect.any/anything 返回 any（@types/jest），直接放进断言会触发
// no-unsafe-assignment；包成显式类型后使用（值仅用于编译期占位）
const MATCHER_STRING = expect.any(String) as unknown as string;
const MATCHER_DATE = expect.any(Date) as unknown as Date;
const MATCHER_OP_DATE = expect.anything() as unknown as FindOperator<Date>;

/**
 * UsersService 单测：用户分页列表 + 角色分配（整体替换、事务、存在性校验）。
 * 事务通过 mock DataSource.transaction 验证：manager 返回独立 txRepo，
 * 断言增删调用发生在 txRepo 上（TypeORM 中默认仓库不受事务保护，这是本模块的关键陷阱）。
 */
describe('UsersService', () => {
  let service: UsersService;
  let users: {
    findOneBy: jest.Mock;
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let roles: { find: jest.Mock; findOneBy: jest.Mock };
  let userRoles: { createQueryBuilder: jest.Mock };
  let txRepos: {
    delete: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeEach(() => {
    users = {
      findOneBy: jest.fn(),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      create: jest.fn((u: object) => u),
      save: jest.fn(),
    };
    roles = { find: jest.fn(), findOneBy: jest.fn() };
    // 最后 admin 保护用：createQueryBuilder 链式 mock（innerJoin → where → getCount）
    // 最后 admin 保护用：createQueryBuilder 单例返回同一 qb（链式 innerJoin → where → getCount），
    // 用例通过 userRoles.createQueryBuilder().getCount.mockResolvedValue(n) 设置计数
    const qb: {
      innerJoin: jest.Mock;
      where: jest.Mock;
      getCount: jest.Mock;
    } = { innerJoin: jest.fn(), where: jest.fn(), getCount: jest.fn() };
    qb.innerJoin.mockReturnValue(qb);
    qb.where.mockReturnValue(qb);
    userRoles = { createQueryBuilder: jest.fn(() => qb) };
    // 事务内 count（最后 admin 保护）与锁查询共用单例 qb
    const txQb: {
      innerJoin: jest.Mock;
      where: jest.Mock;
      getCount: jest.Mock;
    } = { innerJoin: jest.fn(), where: jest.fn(), getCount: jest.fn() };
    txQb.innerJoin.mockReturnValue(txQb);
    txQb.where.mockReturnValue(txQb);
    txRepos = {
      delete: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      save: jest.fn(),
      // 锁查询（SELECT ... FOR UPDATE）与 count 都在事务内走 manager 仓库
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => txQb),
    };
    const dataSource = {
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => {
        // manager 返回独立 txRepo（与默认仓库 mock 区分——验证事务内走 manager）
        return cb({ getRepository: () => txRepos });
      }),
    } as unknown as DataSource;

    service = new UsersService(
      users as never,
      roles as never,
      userRoles as never,
      dataSource,
    );
  });

  describe('listUsers', () => {
    it('分页映射：角色展开为码，软删默认过滤', async () => {
      users.findAndCount.mockResolvedValue([
        [
          {
            id: '7',
            username: 'alice',
            email: null,
            phone: null,
            nickname: null,
            status: 'active',
            createdAt: new Date(),
            roles: [{ code: 'admin' }, { code: 'user' }],
          },
        ],
        1,
      ]);
      const result = await service.listUsers({ page: 1, pageSize: 10 });
      expect(result.total).toBe(1);
      expect(result.items[0].roles).toEqual(['admin', 'user']);
      expect(users.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 10 }),
      );
    });

    it('pageSize 超上限钳制到 100', async () => {
      users.findAndCount.mockResolvedValue([[], 0]);
      await service.listUsers({ page: 2, pageSize: 999 });
      expect(users.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 100, take: 100 }),
      );
    });
  });

  describe('assignUserRoles', () => {
    /**
     * 目标查询与操作者查询现在都走 findOne（目标需 relations.roles 供降级防护），
     * 按 where.id 区分：'op' 返回操作者，其余返回目标（roles 可覆盖）。
     */
    const mockFindOne = (target: object | null, operator: object | null) =>
      users.findOne.mockImplementation((opts: { where: { id: string } }) =>
        Promise.resolve(opts.where.id === 'op' ? operator : target),
      );

    it('用户不存在 → 404', async () => {
      mockFindOne(null, null);
      await expect(
        service.assignUserRoles('99', ['1'], 'op'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('角色存在性校验：无效角色 → 400', async () => {
      mockFindOne({ id: '7', roles: [] }, { id: 'op', roles: [] });
      roles.find.mockResolvedValue([{ id: '1' }]);
      await expect(
        service.assignUserRoles('7', ['1', '2'], 'op'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('整体替换在事务内完成（先清后插）', async () => {
      mockFindOne(
        { id: '7', roles: [] },
        { id: 'op', roles: [{ code: 'admin' }] }, // admin 操作者：旁路
      );
      roles.find.mockResolvedValue([{ id: '1' }]);
      await service.assignUserRoles('7', ['1'], 'op');
      expect(txRepos.delete).toHaveBeenCalledWith({ userId: '7' });
      expect(txRepos.insert).toHaveBeenCalledWith([
        { userId: '7', roleId: '1' },
      ]);
    });

    it('提权防护：非 admin 操作者分配自己未拥有的角色（如 admin）→ 403', async () => {
      mockFindOne(
        { id: '7', roles: [] },
        { id: 'op', roles: [{ id: 'user-role', code: 'user' }] },
      );
      roles.find.mockResolvedValue([{ id: 'admin-role' }]);
      await expect(
        service.assignUserRoles('7', ['admin-role'], 'op'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(txRepos.delete).not.toHaveBeenCalled(); // 校验失败不得落库
    });

    it('提权防护：目标角色 ⊆ 操作者角色 → 放行', async () => {
      mockFindOne(
        { id: '7', roles: [] },
        { id: 'op', roles: [{ id: 'user-role', code: 'user' }] },
      );
      roles.find.mockResolvedValue([{ id: 'user-role' }]);
      await service.assignUserRoles('7', ['user-role'], 'op');
      expect(txRepos.insert).toHaveBeenCalledWith([
        { userId: '7', roleId: 'user-role' },
      ]);
    });

    it('提权防护：操作者不存在 → 403（防御性兜底）', async () => {
      mockFindOne({ id: '7', roles: [] }, null);
      roles.find.mockResolvedValue([{ id: '1' }]);
      await expect(
        service.assignUserRoles('7', ['1'], 'op'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(txRepos.delete).not.toHaveBeenCalled();
    });

    it('降级防护：非 admin 操作者清空管理员账号的角色（[]）→ 403', async () => {
      mockFindOne(
        { id: '9', roles: [{ id: 'r-admin', code: 'admin' }] },
        { id: 'op', roles: [{ id: 'r-manager', code: 'role-manager' }] },
      );
      await expect(
        service.assignUserRoles('9', [], 'op'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(txRepos.delete).not.toHaveBeenCalled();
    });

    it('降级防护：admin 操作者可管理管理员账号（旁路例外）', async () => {
      mockFindOne(
        { id: '9', roles: [{ id: 'r-admin', code: 'admin' }] },
        { id: 'op', roles: [{ id: 'r-admin', code: 'admin' }] },
      );
      roles.find.mockResolvedValue([{ id: 'r-admin' }]);
      await service.assignUserRoles('9', ['r-admin'], 'op');
      expect(txRepos.insert).toHaveBeenCalledWith([
        { userId: '9', roleId: 'r-admin' },
      ]);
    });

    it('最后 admin 保护：角色替换在事务内锁 admin 行后拒绝移除唯一管理员', async () => {
      mockFindOne(
        { id: '9', roles: [{ id: 'r-admin', code: 'admin' }] },
        { id: 'op', roles: [{ id: 'r-admin', code: 'admin' }] },
      );
      roles.findOneBy.mockResolvedValue({ id: 'r-admin' });
      txRepos.findOne.mockResolvedValue({ id: 'r-admin' });
      (
        txRepos.createQueryBuilder() as unknown as { getCount: jest.Mock }
      ).getCount.mockResolvedValue(1);

      await expect(
        service.assignUserRoles('9', [], 'op'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(txRepos.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(txRepos.delete).not.toHaveBeenCalled();
    });
  });

  describe('createUser', () => {
    it('规范化（邮箱小写/手机去分隔符）+ 默认 active + 密码哈希', async () => {
      users.findOne.mockResolvedValue(null);
      users.save.mockResolvedValue({
        id: '9',
        username: 'admin2',
        status: 'active',
      });
      const result = await service.createUser({
        username: 'admin2',
        password: 'secret123',
        email: '  Alice@Example.com ',
        phone: '+86 138-0013-8000',
        nickname: '二号',
      });
      expect(users.save).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'admin2',
          email: 'alice@example.com',
          phone: '+8613800138000',
          nickname: '二号',
          passwordHash: MATCHER_STRING,
        }),
      );
      expect(result.status).toBe('active');
    });

    it('标识冲突（活跃行 409）', async () => {
      users.findOne.mockResolvedValue({
        id: '1',
        username: 'taken',
        deletedAt: null,
      });
      await expect(
        service.createUser({ username: 'taken', password: 'secret123' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('并发冲突：唯一索引 23505 兜底 → 409（不裸抛 500）', async () => {
      users.findOne.mockResolvedValue(null);
      users.save.mockRejectedValue({ driverError: { code: '23505' } });
      await expect(
        service.createUser({ username: 'dup', password: 'secret123' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('超长密码（>72 字节）→ 400（与注册同规则）', async () => {
      await expect(
        service.createUser({ username: 'u', password: '汉'.repeat(30) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateUser', () => {
    it('只落传入字段 + 未修改字段保留持久化真实值（保存后重查）', async () => {
      const user = {
        id: '7',
        username: 'alice',
        status: 'active',
        nickname: '旧昵称',
        realName: '张三',
        gender: 'male',
        avatarUrl: 'https://old/a.png',
        remark: '旧备注',
        email: null,
        phone: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      users.findOneBy.mockResolvedValue(user);
      users.save.mockImplementation((u: object) => Promise.resolve(u));
      const result = await service.updateUser('7', { nickname: '新昵称' });
      expect(result.nickname).toBe('新昵称');
      // 未修改字段：响应反映持久化真实值，不是被 Object.assign 改写成 undefined 的内存值
      expect(result.realName).toBe('张三');
      expect(result.gender).toBe('male');
      expect(result.avatarUrl).toBe('https://old/a.png');
      expect(result.remark).toBe('旧备注');
      expect(result.username).toBe('alice'); // 登录标识不可改
      expect(result.status).toBe('active');
      // P1：返回投影（非同一实体引用），passwordHash 不外泄
      expect(result).not.toBe(user);
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('用户不存在 → 404', async () => {
      users.findOneBy.mockResolvedValue(null);
      await expect(
        service.updateUser('99', { nickname: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateUserStatus', () => {
    /** 完整用户（含 relations 后的 roles；本 spec 无 makeUser，内联构造） */
    const fullUser = (overrides: object = {}) => ({
      id: '7',
      username: 'alice',
      email: null,
      phone: null,
      nickname: null,
      realName: null,
      gender: null,
      birthDate: null,
      avatarUrl: null,
      status: 'active',
      remark: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      passwordHash: '$2b$10$fakehash',
      sessionVersion: 0,
      deletedAt: null,
      roles: [],
      ...overrides,
    });
    /** findOne 按 where.id 区分：'op' 返回操作者（非 admin），其余返回目标 */
    const mockFindOneBy = (target: object) =>
      users.findOne.mockImplementation((opts: { where: { id: string } }) =>
        Promise.resolve(
          opts.where.id === 'op' ? { id: 'op', roles: [] } : target,
        ),
      );

    it('禁用 → 撤销会话且返回管理端投影（passwordHash 不外泄）', async () => {
      mockFindOneBy(fullUser());
      // 状态保存走事务 manager 仓库（TypeORM 默认仓库不受事务保护）
      txRepos.save.mockImplementation((u: object) => Promise.resolve(u));
      const result = await service.updateUserStatus(
        '7',
        { status: 'disabled' },
        'op',
      );
      // P1：返回 AdminUser 投影，绝不含内部列
      expect(result).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('sessionVersion');
      expect(result).not.toHaveProperty('deletedAt');
      expect(txRepos.update).toHaveBeenCalledWith(
        { userId: '7', revokedAt: MATCHER_OP_DATE },
        { revokedAt: MATCHER_DATE },
      );
    });

    it('恢复 active 不撤销会话（历史已撤销行保留审计）', async () => {
      mockFindOneBy(fullUser({ status: 'disabled' }));
      txRepos.save.mockImplementation((u: object) => Promise.resolve(u));
      await service.updateUserStatus('7', { status: 'active' }, 'op');
      expect(txRepos.update).not.toHaveBeenCalled();
    });

    it('用户不存在 → 404', async () => {
      users.findOne.mockResolvedValue(null);
      await expect(
        service.updateUserStatus('99', { status: 'disabled' }, 'op'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('降级防护：非 admin 操作者禁用管理员账号 → 403', async () => {
      users.findOne.mockImplementation((opts: { where: { id: string } }) =>
        Promise.resolve(
          opts.where.id === 'op'
            ? { id: 'op', roles: [] }
            : fullUser({ id: '9', roles: [{ id: 'r-admin', code: 'admin' }] }),
        ),
      );
      await expect(
        service.updateUserStatus('9', { status: 'disabled' }, 'op'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('降级防护：admin 操作者可禁用管理员账号（旁路例外）', async () => {
      users.findOne.mockImplementation((opts: { where: { id: string } }) =>
        Promise.resolve(
          opts.where.id === 'op'
            ? { id: 'op', roles: [{ id: 'r-admin', code: 'admin' }] }
            : fullUser({ id: '9', roles: [{ id: 'r-admin', code: 'admin' }] }),
        ),
      );
      txRepos.save.mockImplementation((u: object) => Promise.resolve(u));
      await service.updateUserStatus('9', { status: 'disabled' }, 'op');
      expect(txRepos.save).toHaveBeenCalled(); // 状态保存走事务 manager 仓库
    });

    it('最后 admin 保护：admin 禁用唯一活跃 admin → 403（不能锁死系统）', async () => {
      users.findOne.mockImplementation((opts: { where: { id: string } }) =>
        Promise.resolve(
          opts.where.id === 'op'
            ? { id: 'op', roles: [{ id: 'r-admin', code: 'admin' }] }
            : fullUser({ id: '9', roles: [{ id: 'r-admin', code: 'admin' }] }),
        ),
      );
      // 事务内锁查询（SELECT ... FOR UPDATE）返回 admin 角色行
      txRepos.findOne.mockResolvedValue({ id: 'r-admin' });
      // 活跃 admin 数 = 1（只有目标自己）→ 拒绝
      (
        txRepos.createQueryBuilder() as unknown as { getCount: jest.Mock }
      ).getCount.mockResolvedValue(1);
      await expect(
        service.updateUserStatus('9', { status: 'disabled' }, 'op'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(txRepos.update).not.toHaveBeenCalled();
      // 锁在事务内执行（findOne 带 lock 选项）
      expect(txRepos.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('最后 admin 保护：仍有其他活跃 admin 时放行', async () => {
      users.findOne.mockImplementation((opts: { where: { id: string } }) =>
        Promise.resolve(
          opts.where.id === 'op'
            ? { id: 'op', roles: [{ id: 'r-admin', code: 'admin' }] }
            : fullUser({ id: '9', roles: [{ id: 'r-admin', code: 'admin' }] }),
        ),
      );
      txRepos.findOne.mockResolvedValue({ id: 'r-admin' });
      (
        txRepos.createQueryBuilder() as unknown as { getCount: jest.Mock }
      ).getCount.mockResolvedValue(2);
      txRepos.save.mockImplementation((u: object) => Promise.resolve(u));
      await service.updateUserStatus('9', { status: 'disabled' }, 'op');
      expect(txRepos.update).toHaveBeenCalled();
    });
  });
});
