import { RbacController } from '@/modules/rbac/rbac.controller';

/**
 * RbacController 单测：验证 6 个端点（角色 CRUD/分配权限/权限点列表）
 * 原样转发参数并返回 service 结果（与 users.controller.spec 同模式）。
 */
describe('RbacController', () => {
  let controller: RbacController;
  let service: {
    listRoles: jest.Mock;
    createRole: jest.Mock;
    updateRole: jest.Mock;
    deleteRole: jest.Mock;
    assignRolePermissions: jest.Mock;
    listPermissions: jest.Mock;
  };

  beforeEach(() => {
    service = {
      listRoles: jest.fn(),
      createRole: jest.fn(),
      updateRole: jest.fn(),
      deleteRole: jest.fn(),
      assignRolePermissions: jest.fn(),
      listPermissions: jest.fn(),
    };
    controller = new RbacController(service as never);
  });

  it('listRoles：转发 service', async () => {
    service.listRoles.mockResolvedValue([]);
    await controller.listRoles();
    expect(service.listRoles).toHaveBeenCalledTimes(1);
  });

  it('createRole：透传 DTO', async () => {
    const dto = { code: 'editor', name: '编辑' };
    service.createRole.mockResolvedValue({ id: '1' });
    await controller.createRole(dto);
    expect(service.createRole).toHaveBeenCalledWith(dto);
  });

  it('updateRole：透传 id + DTO', async () => {
    const dto = { name: '新名' };
    service.updateRole.mockResolvedValue({ id: '2' });
    await controller.updateRole('2', dto);
    expect(service.updateRole).toHaveBeenCalledWith('2', dto);
  });

  it('deleteRole：透传 id', async () => {
    service.deleteRole.mockResolvedValue(undefined);
    await controller.deleteRole('2');
    expect(service.deleteRole).toHaveBeenCalledWith('2');
  });

  it('assignRolePermissions：拆出 permissionIds + 操作者 ID 传给 service', async () => {
    service.assignRolePermissions.mockResolvedValue(undefined);
    await controller.assignRolePermissions('2', { permissionIds: ['p1'] }, {
      user: { id: 'op' },
    } as never);
    expect(service.assignRolePermissions).toHaveBeenCalledWith(
      '2',
      ['p1'],
      'op',
    );
  });

  it('listPermissions：转发 service', async () => {
    service.listPermissions.mockResolvedValue([]);
    await controller.listPermissions();
    expect(service.listPermissions).toHaveBeenCalledTimes(1);
  });
});
