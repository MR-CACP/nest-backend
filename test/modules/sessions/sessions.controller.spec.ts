import { SessionsController } from '@/modules/sessions/sessions.controller';

/**
 * SessionsController 单测：验证 3 个端点（列表/单会话下线/全部下线）
 * 原样转发参数并返回 service 结果，且两个下线入口正确透传操作者 ID。
 * 说明：装饰器（守卫/权限点/Swagger）由 e2e 覆盖真实链路（权限隔离 403、
 * 降级防护 403），这里只钉住 handler 的转发契约，防止改动时参数错位。
 */
describe('SessionsController', () => {
  let controller: SessionsController;
  let service: {
    list: jest.Mock;
    revokeOne: jest.Mock;
    revokeAllByUser: jest.Mock;
  };

  beforeEach(() => {
    service = {
      list: jest.fn(),
      revokeOne: jest.fn(),
      revokeAllByUser: jest.fn(),
    };
    controller = new SessionsController(service as never);
  });

  it('listSessions：透传分页/筛选 query', async () => {
    const query = { page: 2, pageSize: 20, username: 'alice' };
    service.list.mockResolvedValue({
      items: [],
      total: 0,
      page: 2,
      pageSize: 20,
    });
    await controller.listSessions(query);
    expect(service.list).toHaveBeenCalledWith(query);
  });

  it('revokeSession：透传 id + 操作者 ID（req.user.id）', async () => {
    service.revokeOne.mockResolvedValue(undefined);
    await controller.revokeSession('s1', {
      user: { id: 'op' },
      ip: '1.2.3.4',
    } as never);
    expect(service.revokeOne).toHaveBeenCalledWith('s1', 'op', '1.2.3.4');
  });

  it('revokeUserSessions：透传 id + 操作者 ID（req.user.id）', async () => {
    service.revokeAllByUser.mockResolvedValue(undefined);
    await controller.revokeUserSessions('u1', {
      user: { id: 'op' },
      ip: '1.2.3.4',
    } as never);
    expect(service.revokeAllByUser).toHaveBeenCalledWith('u1', 'op', '1.2.3.4');
  });
});
