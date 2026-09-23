import { AuditController } from '@/modules/audit/audit.controller';

/**
 * AuditController 单测：两个查询端点原样转发 query 并返回 service 结果。
 * 说明：装饰器（@Permissions(AUDIT_READ) 访问控制 / Swagger）由 e2e 覆盖真实链路，
 * 这里只钉住 handler 的转发契约。
 */
describe('AuditController', () => {
  let controller: AuditController;
  let service: {
    listLoginLogs: jest.Mock;
    listLogs: jest.Mock;
  };

  beforeEach(() => {
    service = {
      listLoginLogs: jest.fn(),
      listLogs: jest.fn(),
    };
    controller = new AuditController(service as never);
  });

  it('listLoginLogs：透传 query', async () => {
    const query = { page: 1, pageSize: 20, success: true };
    service.listLoginLogs.mockResolvedValue({ items: [], total: 0 });
    await controller.listLoginLogs(query);
    expect(service.listLoginLogs).toHaveBeenCalledWith(query);
  });

  it('listLogs：透传 query（含筛选）', async () => {
    const query = { page: 2, pageSize: 50, action: 'role.create' };
    service.listLogs.mockResolvedValue({ items: [], total: 0 });
    await controller.listLogs(query);
    expect(service.listLogs).toHaveBeenCalledWith(query);
  });
});
