import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';

import { AuditLog } from '../../../src/modules/audit/entities/audit-log.entity';
import { LoginLog } from '../../../src/modules/audit/entities/login-log.entity';
import { RefreshToken } from '../../../src/modules/auth/entities/refresh-token.entity';
import { CleanupService } from '../../../src/modules/cleanup/cleanup.service';
import { JobRun } from '../../../src/modules/jobs/entities/job-run.entity';

/** 定时清理单测：覆盖保留期边界、分批循环、审计表双表清理与"失败不抛出"取舍 */
describe('CleanupService', () => {
  const NOW = new Date('2026-09-23T12:00:00Z');

  let service: CleanupService;
  let refreshTokens: { find: jest.Mock; delete: jest.Mock };
  let loginLogs: { find: jest.Mock; delete: jest.Mock };
  let auditLogs: { find: jest.Mock; delete: jest.Mock };
  let jobRuns: { find: jest.Mock; delete: jest.Mock };

  const makeRepoMock = () => ({
    find: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
  });

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);

    refreshTokens = makeRepoMock();
    loginLogs = makeRepoMock();
    auditLogs = makeRepoMock();
    jobRuns = makeRepoMock();

    const moduleRef = await Test.createTestingModule({
      providers: [
        CleanupService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue({
              refreshTokenRetentionDays: 30,
              auditRetentionDays: 180,
            }),
          },
        },
        { provide: getRepositoryToken(RefreshToken), useValue: refreshTokens },
        { provide: getRepositoryToken(LoginLog), useValue: loginLogs },
        { provide: getRepositoryToken(AuditLog), useValue: auditLogs },
        { provide: getRepositoryToken(JobRun), useValue: jobRuns },
      ],
    }).compile();

    service = moduleRef.get(CleanupService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('cleanExpiredRefreshTokens', () => {
    it('删除过期超过保留期的行，cutoff = now - 30 天', async () => {
      refreshTokens.find.mockResolvedValue([{ id: '1' }, { id: '2' }]);

      await service.cleanExpiredRefreshTokens();

      // where 形状单独断言（objectContaining 内嵌 expect.any 会触发 no-unsafe-assignment）
      expect(refreshTokens.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1000 }),
      );
      // LessThan 操作符的值 = cutoff（私有字段不可访问，精确时间由 e2e 真库验证——
      // 这里只钉"用的是小于操作符 + 触发删除"）
      const findArgs = (
        refreshTokens.find.mock.calls as Array<
          [{ where: { expiresAt: FindOperator<Date> } }]
        >
      )[0][0];
      expect(findArgs.where.expiresAt).toBeInstanceOf(FindOperator);
      expect(refreshTokens.delete).toHaveBeenCalledWith(['1', '2']);
    });

    it('保留期内（无过期行）不触发删除', async () => {
      await service.cleanExpiredRefreshTokens();

      expect(refreshTokens.find).toHaveBeenCalled();
      expect(refreshTokens.delete).not.toHaveBeenCalled();
    });

    it('超过批大小（1000）时分批循环直到清空', async () => {
      refreshTokens.find
        .mockResolvedValueOnce(
          Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })),
        )
        .mockResolvedValueOnce(
          Array.from({ length: 1000 }, (_, i) => ({ id: String(i + 1000) })),
        )
        .mockResolvedValueOnce([{ id: '2001' }]);

      await service.cleanExpiredRefreshTokens();

      expect(refreshTokens.find).toHaveBeenCalledTimes(3);
      expect(refreshTokens.delete).toHaveBeenCalledTimes(3);
    });

    it('find 抛错向上传播（由调度层 runAction 记 failed，本服务不吞错）', async () => {
      refreshTokens.find.mockRejectedValue(new Error('db down'));

      await expect(service.cleanExpiredRefreshTokens()).rejects.toThrow(
        'db down',
      );
    });
  });

  describe('cleanAuditLogs', () => {
    it('login_logs 与 audit_logs 都按各自保留期清理', async () => {
      loginLogs.find.mockResolvedValue([{ id: '11' }]);
      auditLogs.find.mockResolvedValue([{ id: '21' }, { id: '22' }]);

      await service.cleanAuditLogs();

      // login 表：created_at 用小于操作符（精确 cutoff 由 e2e 真库验证）
      expect(loginLogs.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1000 }),
      );
      const loginArgs = (
        loginLogs.find.mock.calls as Array<
          [{ where: { createdAt: FindOperator<Date> } }]
        >
      )[0][0];
      expect(loginArgs.where.createdAt).toBeInstanceOf(FindOperator);
      expect(loginLogs.delete).toHaveBeenCalledWith(['11']);

      // audit 表：同一 cutoff 语义
      const auditArgs = (
        auditLogs.find.mock.calls as Array<
          [{ where: { createdAt: FindOperator<Date> } }]
        >
      )[0][0];
      expect(auditArgs.where.createdAt).toBeInstanceOf(FindOperator);
      expect(auditLogs.delete).toHaveBeenCalledWith(['21', '22']);
    });

    it('无过期行时两表都不删除', async () => {
      await service.cleanAuditLogs();

      expect(loginLogs.delete).not.toHaveBeenCalled();
      expect(auditLogs.delete).not.toHaveBeenCalled();
    });

    it('login_logs 查询抛错向上传播（不吞）', async () => {
      loginLogs.find.mockRejectedValue(new Error('audit db down'));

      await expect(service.cleanAuditLogs()).rejects.toThrow('audit db down');
      // 第一张表失败即中止：audit_logs 不继续清理（整体记为一次 failed）
      expect(auditLogs.find).not.toHaveBeenCalled();
    });
  });

  describe('cleanJobRuns', () => {
    it('job_runs 按审计保留期清理（started_at 小于操作符）', async () => {
      jobRuns.find.mockResolvedValue([{ id: '31' }, { id: '32' }]);

      await service.cleanJobRuns();

      const args = (
        jobRuns.find.mock.calls as Array<
          [{ where: { startedAt: FindOperator<Date> } }]
        >
      )[0][0];
      expect(args.where.startedAt).toBeInstanceOf(FindOperator);
      expect(jobRuns.delete).toHaveBeenCalledWith(['31', '32']);
    });

    it('无过期行时不删除', async () => {
      await service.cleanJobRuns();

      expect(jobRuns.delete).not.toHaveBeenCalled();
    });

    it('job_runs 查询抛错向上传播（不吞）', async () => {
      jobRuns.find.mockRejectedValue(new Error('job db down'));

      await expect(service.cleanJobRuns()).rejects.toThrow('job db down');
    });
  });
});
