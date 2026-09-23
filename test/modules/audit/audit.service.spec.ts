import { PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';

import { AuditService } from '@/modules/audit/audit.service';
import { AuditLog } from '@/modules/audit/entities/audit-log.entity';
import { LoginLog } from '@/modules/audit/entities/login-log.entity';

/**
 * AuditService 单测：管理操作审计（audit_logs）写入（尽力而为）与查询（分页/筛选）。
 * 注意：登录日志的**写入**已不在本服务（真实路径是 AuthService.recordLoginLog，
 * 其契约用例在 auth.service.spec「recordLoginLog」describe）——本服务只负责
 * login_logs 的查询（listLoginLogs）。
 */
describe('AuditService', () => {
  let service: AuditService;
  let loginLogs: {
    save: jest.Mock;
    create: jest.Mock;
    findAndCount: jest.Mock;
  };
  let auditLogs: {
    // save 带参数泛型：mock.calls 类型化为 [object][]，杜绝 calls[0] 的 any 成员访问
    save: jest.Mock<Promise<object>, [object]>;
    create: jest.Mock;
    findAndCount: jest.Mock;
  };
  let logger: { warn: jest.Mock };

  beforeEach(() => {
    loginLogs = {
      save: jest.fn(),
      create: jest.fn((e: Partial<LoginLog>) => e as LoginLog),
      findAndCount: jest.fn(),
    };
    auditLogs = {
      save: jest.fn() as jest.Mock<Promise<object>, [object]>,
      create: jest.fn((e: Partial<AuditLog>) => e as AuditLog),
      findAndCount: jest.fn(),
    };
    logger = { warn: jest.fn() };
    service = new AuditService(
      loginLogs as unknown as Repository<LoginLog>,
      auditLogs as unknown as Repository<AuditLog>,
      logger as unknown as PinoLogger,
    );
  });

  describe('recordLogin', () => {
    it('已删除：登录日志写入归 AuthService（避免两份实现只测死代码）', () => {
      expect(AuditService.prototype).not.toHaveProperty('recordLogin');
    });
  });

  describe('record', () => {
    it('成功：写入完整审计行（detail 原样透传 + ip 透传）', async () => {
      auditLogs.save.mockResolvedValue({});
      await service.record({
        operatorId: 'op1',
        action: 'user.status.update',
        resourceType: 'user',
        resourceId: 'u1',
        detail: { from: 'active', to: 'disabled' },
        ip: '1.2.3.4',
      });
      expect(auditLogs.save).toHaveBeenCalledWith({
        operatorId: 'op1',
        action: 'user.status.update',
        resourceType: 'user',
        resourceId: 'u1',
        detail: { from: 'active', to: 'disabled' },
        ip: '1.2.3.4',
      });
    });

    it('ip 超长：落库前裁到 45（列宽由写入方保证，不靠 req.ip 天然有界）', async () => {
      auditLogs.save.mockResolvedValue({});
      await service.record({
        action: 'role.create',
        resourceType: 'role',
        ip: '9'.repeat(60),
      });
      const saved = auditLogs.save.mock.calls[0][0] as { ip: string };
      expect(saved.ip).toHaveLength(45);
    });

    it('写入抛错：只记 warn，不向上抛出', async () => {
      auditLogs.save.mockRejectedValue(new Error('db down'));
      await expect(
        service.record({ action: 'role.create', resourceType: 'role' }),
      ).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'audit.recordFailed' }),
        expect.any(String),
      );
    });
  });

  describe('listLoginLogs', () => {
    it('默认分页 + 时间倒序', async () => {
      loginLogs.findAndCount.mockResolvedValue([[], 0]);
      const result = await service.listLoginLogs({});
      expect(loginLogs.findAndCount).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: 0,
        take: 20,
      });
      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it('success 过滤 + 自定义分页；pageSize 上限 100', async () => {
      loginLogs.findAndCount.mockResolvedValue([[], 0]);
      await service.listLoginLogs({ page: 2, pageSize: 500, success: false });
      expect(loginLogs.findAndCount).toHaveBeenCalledWith({
        where: { success: false },
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: 100,
        take: 100,
      });
    });
  });

  describe('listLogs', () => {
    it('筛选条件按需组合（action/operatorId/resourceType）', async () => {
      auditLogs.findAndCount.mockResolvedValue([[], 0]);
      await service.listLogs({
        action: 'user.create',
        operatorId: 'op1',
        resourceType: 'role',
      });
      expect(auditLogs.findAndCount).toHaveBeenCalledWith({
        where: {
          action: 'user.create',
          operatorId: 'op1',
          resourceType: 'role',
        },
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: 0,
        take: 20,
      });
    });

    it('无筛选条件：空 where（不漏查）', async () => {
      auditLogs.findAndCount.mockResolvedValue([[], 0]);
      await service.listLogs({});
      expect(auditLogs.findAndCount).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: 0,
        take: 20,
      });
    });
  });
});
