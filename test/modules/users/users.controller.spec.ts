import { UsersController } from '@/modules/users/users.controller';

/**
 * UsersController 单测：验证 5 个端点（列表/创建/资料/状态/分配角色）
 * 原样转发参数并返回 service 结果。
 * 说明：装饰器（守卫/权限点/Swagger）由 e2e 覆盖真实链路，
 * 这里只钉住 handler 的转发契约，防止改动时参数错位。
 */
describe('UsersController', () => {
  let controller: UsersController;
  let service: {
    listUsers: jest.Mock;
    createUser: jest.Mock;
    updateUser: jest.Mock;
    updateUserStatus: jest.Mock;
    assignUserRoles: jest.Mock;
  };

  beforeEach(() => {
    service = {
      listUsers: jest.fn(),
      createUser: jest.fn(),
      updateUser: jest.fn(),
      updateUserStatus: jest.fn(),
      assignUserRoles: jest.fn(),
    };
    controller = new UsersController(service as never);
  });

  it('listUsers：透传分页 query', async () => {
    const query = { page: 2, pageSize: 20 };
    service.listUsers.mockResolvedValue({
      items: [],
      total: 0,
      page: 2,
      pageSize: 20,
    });
    await controller.listUsers(query);
    expect(service.listUsers).toHaveBeenCalledWith(query);
  });

  it('createUser：透传 DTO', async () => {
    const dto = { username: 'u', password: 'secret123' };
    service.createUser.mockResolvedValue({ id: '1' });
    await controller.createUser(dto);
    expect(service.createUser).toHaveBeenCalledWith(dto);
  });

  it('updateUser：透传 id + DTO', async () => {
    const dto = { nickname: 'x' };
    service.updateUser.mockResolvedValue({ id: '7' });
    await controller.updateUser('7', dto);
    expect(service.updateUser).toHaveBeenCalledWith('7', dto);
  });

  it('updateUserStatus：透传 id + DTO + 操作者 ID', async () => {
    const dto: { status: 'disabled' } = { status: 'disabled' };
    service.updateUserStatus.mockResolvedValue({ id: '7', status: 'disabled' });
    await controller.updateUserStatus('7', dto, {
      user: { id: 'op' },
    } as never);
    expect(service.updateUserStatus).toHaveBeenCalledWith('7', dto, 'op');
  });

  it('assignUserRoles：拆出 roleIds + 操作者 ID 传给 service', async () => {
    service.assignUserRoles.mockResolvedValue(undefined);
    await controller.assignUserRoles('7', { roleIds: ['r1', 'r2'] }, {
      user: { id: 'op' },
    } as never);
    expect(service.assignUserRoles).toHaveBeenCalledWith(
      '7',
      ['r1', 'r2'],
      'op',
    );
  });
});
