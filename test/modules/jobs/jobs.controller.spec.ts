import { JobController } from '@/modules/jobs/jobs.controller';

/**
 * JobController 单测：验证 7 个端点（列表/创建/更新/启停/手动执行/删除/执行日志）
 * 原样转发参数并返回 service 结果。
 * 说明：装饰器（守卫/权限点/Swagger/@HttpCode）由 e2e 覆盖真实链路，
 * 这里只钉住 handler 的转发契约，防止改动时参数错位。
 */
describe('JobController', () => {
  let controller: JobController;
  let service: {
    list: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateStatus: jest.Mock;
    run: jest.Mock;
    remove: jest.Mock;
    listRuns: jest.Mock;
  };

  beforeEach(() => {
    service = {
      list: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateStatus: jest.fn(),
      run: jest.fn(),
      remove: jest.fn(),
      listRuns: jest.fn(),
    };
    controller = new JobController(service as never);
  });

  it('list：透传分页 query', async () => {
    const query = { page: 2, pageSize: 20, status: 'enabled' as const };
    service.list.mockResolvedValue({
      items: [],
      total: 0,
      page: 2,
      pageSize: 20,
    });
    await controller.list(query);
    expect(service.list).toHaveBeenCalledWith(query);
  });

  it('create：透传 DTO + 操作者（operatorId/ip 供审计）', async () => {
    const dto = {
      name: 'cleanup-refresh-tokens',
      actionCode: 'cleanup:refresh-tokens',
      cronExpression: '0 3 * * *',
    };
    const req = { user: { id: 'op-1' }, ip: '1.2.3.4' };
    service.create.mockResolvedValue({ id: '1' });
    await controller.create(dto, req as never);
    expect(service.create).toHaveBeenCalledWith(dto, 'op-1', '1.2.3.4');
  });

  it('update：透传 id + DTO + 操作者', async () => {
    const dto = { cronExpression: '0 4 * * *' };
    const req = { user: { id: 'op-1' }, ip: '1.2.3.4' };
    service.update.mockResolvedValue({ id: '7' });
    await controller.update('7', dto, req as never);
    expect(service.update).toHaveBeenCalledWith('7', dto, 'op-1', '1.2.3.4');
  });

  it('updateStatus：透传 id + 状态 + 操作者', async () => {
    const dto = { status: 'disabled' as const };
    const req = { user: { id: 'op-1' }, ip: '1.2.3.4' };
    service.updateStatus.mockResolvedValue({ id: '7' });
    await controller.updateStatus('7', dto, req as never);
    expect(service.updateStatus).toHaveBeenCalledWith(
      '7',
      dto,
      'op-1',
      '1.2.3.4',
    );
  });

  it('run：透传 id + 操作者，返回执行结果', async () => {
    const req = { user: { id: 'op-1' }, ip: '1.2.3.4' };
    service.run.mockResolvedValue({ jobId: '7', name: 'x', status: 'success' });
    await controller.run('7', req as never);
    expect(service.run).toHaveBeenCalledWith('7', 'op-1', '1.2.3.4');
  });

  it('remove：透传 id + 操作者', async () => {
    const req = { user: { id: 'op-1' }, ip: '1.2.3.4' };
    service.remove.mockResolvedValue(undefined);
    await controller.remove('7', req as never);
    expect(service.remove).toHaveBeenCalledWith('7', 'op-1', '1.2.3.4');
  });

  it('listRuns：透传 id + 分页 query', async () => {
    const query = { page: 1, pageSize: 10, status: 'success' as const };
    service.listRuns.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
    });
    await controller.listRuns('7', query);
    expect(service.listRuns).toHaveBeenCalledWith('7', query);
  });
});
