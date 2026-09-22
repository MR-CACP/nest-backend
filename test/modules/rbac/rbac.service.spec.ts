import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { Role } from '@/modules/rbac/entities/role.entity';
import { RbacService } from '@/modules/rbac/rbac.service';

/** 构造最小 Role（isSystem 可覆盖） */
const makeRole = (overrides: Partial<Role> = {}): Role => ({
  id: '1',
  code: 'editor',
  name: '编辑',
  description: null,
  isSystem: false,
  permissions: [],
  users: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  ...overrides,
});

/**
 * RbacService 单测：管理端保护逻辑（系统角色只读 / 冲突 / 事务整体替换）。
 * 事务通过 mock DataSource.transaction 验证：manager 返回独立 txRepo，
 * 断言增删调用发生在 txRepo 上（TypeORM 中默认仓库不受事务保护，这是本模块的关键陷阱）。
 */
describe('RbacService', () => {
  let service: RbacService;
  let roles: {
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    softDelete: jest.Mock;
  };
  let permissions: { find: jest.Mock };
  let userRoles: { count: jest.Mock };
  let rolePermissions: { find: jest.Mock };
  let users: { findOne: jest.Mock };
  let txRepos: { delete: jest.Mock; insert: jest.Mock; softDelete: jest.Mock };

  beforeEach(() => {
    roles = {
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      softDelete: jest.fn(),
    };
    permissions = { find: jest.fn() };
    userRoles = { count: jest.fn() };
    rolePermissions = { find: jest.fn() };
    users = { findOne: jest.fn() };
    txRepos = { delete: jest.fn(), insert: jest.fn(), softDelete: jest.fn() };
    const dataSource = {
      transaction: jest.fn((cb: (m: unknown) => Promise<unknown>) => {
        // manager 返回独立 txRepo（与默认仓库 mock 区分——验证事务内走 manager）
        return cb({ getRepository: () => txRepos });
      }),
      getRepository: jest.fn(() => userRoles),
    } as unknown as DataSource;

    service = new RbacService(
      roles as never,
      permissions as never,
      rolePermissions as never,
      users as never,
      dataSource,
    );
  });

  /** 构造操作者：admin 旁路（拥有全部，可授予任意） */
  const adminOperator = () => ({
    id: 'op',
    roles: [{ code: 'admin', permissions: [] }],
  });

  describe('createRole', () => {
    it('成功创建（isSystem 恒为 false）', async () => {
      roles.findOne.mockResolvedValue(null);
      roles.save.mockImplementation((r: Partial<Role>) => makeRole(r));
      const result = await service.createRole({
        code: 'editor',
        name: '编辑',
      });
      expect(result.isSystem).toBe(false);
      expect(roles.save).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'editor', name: '编辑' }),
      );
    });

    it('code 已存在 → 409', async () => {
      roles.findOne.mockResolvedValue(makeRole());
      await expect(
        service.createRole({ code: 'editor', name: '编辑' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('并发同名：唯一索引 23505 兜底 → 409（不裸抛 500）', async () => {
      roles.findOne.mockResolvedValue(null);
      // mock 形状与 isUniqueViolation 鸭子类型一致（真 QueryFailedError 的 code 在 driverError 上）
      roles.save.mockRejectedValue({ driverError: { code: '23505' } });
      await expect(
        service.createRole({ code: 'editor', name: '编辑' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateRole', () => {
    it('角色不存在 → 404', async () => {
      roles.findOneBy.mockResolvedValue(null);
      await expect(
        service.updateRole('1', { name: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('系统角色 → 403（完全只读）', async () => {
      roles.findOneBy.mockResolvedValue(makeRole({ isSystem: true }));
      await expect(
        service.updateRole('1', { name: 'x' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('普通角色：仅更新 name/description，不触碰 code', async () => {
      const role = makeRole();
      roles.findOneBy.mockResolvedValue(role);
      roles.save.mockImplementation((r: Role) => r);
      await service.updateRole('1', { name: '高级编辑', description: 'd' });
      expect(role.name).toBe('高级编辑');
      expect(role.description).toBe('d');
      expect(role.code).toBe('editor'); // code 不可变
    });

    it('PATCH 部分更新：只传 name 不清空已有描述（undefined 不覆盖）', async () => {
      const role = makeRole({ description: '既有描述' });
      roles.findOneBy.mockResolvedValue(role);
      roles.save.mockImplementation((r: Role) => r);
      await service.updateRole('1', { name: '仅改名' });
      expect(role.name).toBe('仅改名');
      expect(role.description).toBe('既有描述'); // 未被清空
    });

    it('PATCH 部分更新：传空串可显式清空描述', async () => {
      const role = makeRole({ description: '既有描述' });
      roles.findOneBy.mockResolvedValue(role);
      roles.save.mockImplementation((r: Role) => r);
      await service.updateRole('1', { name: '清空', description: '' });
      expect(role.description).toBe('');
    });
  });

  describe('deleteRole', () => {
    it('角色不存在 → 404', async () => {
      roles.findOneBy.mockResolvedValue(null);
      await expect(service.deleteRole('1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('系统角色 → 403', async () => {
      roles.findOneBy.mockResolvedValue(makeRole({ isSystem: true }));
      await expect(service.deleteRole('1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('仍有关联用户 → 409（先解绑再删）', async () => {
      roles.findOneBy.mockResolvedValue(makeRole());
      userRoles.count.mockResolvedValue(2);
      await expect(service.deleteRole('1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('无关联：事务内软删角色 + 清 role_permissions 绑定', async () => {
      roles.findOneBy.mockResolvedValue(makeRole());
      userRoles.count.mockResolvedValue(0);
      await service.deleteRole('1');
      // 软删与清绑定都走 manager 仓库（默认仓库不受事务保护）
      expect(txRepos.delete).toHaveBeenCalledWith({ roleId: '1' });
      expect(txRepos.softDelete).toHaveBeenCalledWith({ id: '1' });
    });
  });

  describe('assignRolePermissions', () => {
    it('系统角色 → 403（种子角色权限由代码声明，不可改）', async () => {
      roles.findOneBy.mockResolvedValue(makeRole({ isSystem: true }));
      await expect(
        service.assignRolePermissions('1', ['10'], 'op'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('权限点存在性校验：无效 ID → 400', async () => {
      roles.findOneBy.mockResolvedValue(makeRole());
      permissions.find.mockResolvedValue([{ id: '10' }]); // 请求 10+11，只找到 10
      await expect(
        service.assignRolePermissions('1', ['10', '11'], 'op'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('整体替换在事务内完成（先清后插，走 manager 仓库而非默认仓库）', async () => {
      roles.findOneBy.mockResolvedValue(makeRole());
      permissions.find.mockResolvedValue([{ id: '10' }, { id: '11' }]);
      users.findOne.mockResolvedValue(adminOperator());
      await service.assignRolePermissions('1', ['10', '10', '11'], 'op');
      // 去重后 2 个 ID
      expect(txRepos.delete).toHaveBeenCalledWith({ roleId: '1' });
      expect(txRepos.insert).toHaveBeenCalledWith([
        { roleId: '1', permissionId: '10' },
        { roleId: '1', permissionId: '11' },
      ]);
    });

    it('空数组 = 清空全部权限（合法语义，不校验）', async () => {
      roles.findOneBy.mockResolvedValue(makeRole());
      await service.assignRolePermissions('1', [], 'op');
      expect(permissions.find).not.toHaveBeenCalled();
      expect(txRepos.delete).toHaveBeenCalledWith({ roleId: '1' });
      expect(txRepos.insert).not.toHaveBeenCalled();
    });

    it('提权防护：操作者没有目标权限 → 403（不能授予自己没有的权限）', async () => {
      roles.findOneBy.mockResolvedValue(makeRole());
      permissions.find.mockResolvedValue([{ id: '10' }, { id: '11' }]);
      // 非 admin：只拥有权限 10（如 role:read），请求绑 10+11
      users.findOne.mockResolvedValue({
        id: 'op',
        roles: [{ code: 'viewer', permissions: [{ id: '10' }] }],
      });
      await expect(
        service.assignRolePermissions('1', ['10', '11'], 'op'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(txRepos.delete).not.toHaveBeenCalled(); // 校验失败不得落库
    });

    it('提权防护：操作者拥有全部目标权限 → 放行（授予集 ⊆ 操作者集）', async () => {
      roles.findOneBy.mockResolvedValue(makeRole());
      permissions.find.mockResolvedValue([{ id: '10' }, { id: '11' }]);
      users.findOne.mockResolvedValue({
        id: 'op',
        roles: [{ code: 'manager', permissions: [{ id: '10' }, { id: '11' }] }],
      });
      await service.assignRolePermissions('1', ['10', '11'], 'op');
      expect(txRepos.insert).toHaveBeenCalled();
    });
  });
});
