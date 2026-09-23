import { BadRequestException, ConflictException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CronJob } from 'cron';

import { AUDIT_ACTIONS } from '../../../src/common/constants/audit.constants';
import { AuditService } from '../../../src/modules/audit/audit.service';
import { CleanupService } from '../../../src/modules/cleanup/cleanup.service';
import { JobDefinition } from '../../../src/modules/jobs/entities/job-definition.entity';
import { JobRun } from '../../../src/modules/jobs/entities/job-run.entity';
import { JobService } from '../../../src/modules/jobs/jobs.service';

/** 定时任务服务单测：动态注册、CRUD 热更新、启停、执行日志（成功/失败）、容错路径、管理审计 */
describe('JobService', () => {
  let service: JobService;
  let schedulerRegistry: { addCronJob: jest.Mock; deleteCronJob: jest.Mock };
  let cleanupService: {
    cleanExpiredRefreshTokens: jest.Mock;
    cleanAuditLogs: jest.Mock;
    cleanJobRuns: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let jobs: {
    find: jest.Mock;
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
    findAndCount: jest.Mock;
  };
  let jobRuns: { save: jest.Mock; findAndCount: jest.Mock };

  /** 操作者标识（埋点断言用） */
  const OP = 'op-1';
  const OP_IP = '1.2.3.4';

  const makeJob = (overrides: Partial<JobDefinition> = {}): JobDefinition =>
    ({
      id: '1',
      name: 'cleanup-refresh-tokens',
      actionCode: 'cleanup:refresh-tokens',
      cronExpression: '0 3 * * *',
      status: 'enabled',
      remark: null,
      ...overrides,
    }) as JobDefinition;

  /**
   * registerJob 创建的是真实 CronJob 并 start()（SchedulerRegistry 是 mock，
   * 不持有实例就不会停它们）。schedulerRegistry 每用例重建、mock.calls 会丢掉
   * 先前用例的实例——用 suite 级数组收集全部实例，afterAll 统一 stop，
   * 避免 jest worker "failed to exit gracefully" 警告。
   */
  const createdCronJobs: CronJob[] = [];

  afterAll(() => {
    for (const instance of createdCronJobs) {
      // cron 4.x 的 stop() 返回 Promise：测试清理不需等待，void 显式忽略
      void instance.stop();
    }
  });

  beforeEach(async () => {
    schedulerRegistry = {
      addCronJob: jest.fn((_name: string, job: CronJob) => {
        createdCronJobs.push(job);
      }),
      // 默认抛错模拟"未注册"（deleteCronJob 对不存在的 job 抛 NotFound）
      deleteCronJob: jest.fn().mockImplementation(() => {
        throw new Error('not found');
      }),
    };
    cleanupService = {
      cleanExpiredRefreshTokens: jest.fn().mockResolvedValue(undefined),
      cleanAuditLogs: jest.fn().mockResolvedValue(undefined),
      cleanJobRuns: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    jobs = {
      find: jest.fn().mockResolvedValue([]),
      findOneBy: jest.fn().mockResolvedValue(null),
      create: jest.fn((v: object) => v),
      save: jest.fn((v) => Promise.resolve(v)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    jobRuns = {
      save: jest.fn().mockResolvedValue({}),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        JobService,
        { provide: SchedulerRegistry, useValue: schedulerRegistry },
        { provide: CleanupService, useValue: cleanupService },
        { provide: AuditService, useValue: audit },
        { provide: getRepositoryToken(JobDefinition), useValue: jobs },
        { provide: getRepositoryToken(JobRun), useValue: jobRuns },
      ],
    }).compile();

    service = moduleRef.get(JobService);
  });

  describe('onModuleInit 动态注册', () => {
    it('只注册 enabled 任务（find 已带 where 过滤，DB 侧保证）', async () => {
      jobs.find.mockResolvedValue([
        makeJob({ id: '1' }),
        makeJob({ id: '2' }),
        makeJob({ id: '3' }),
      ]);

      await service.onModuleInit();

      // 过滤由 find 的 where:{status:'enabled'} 承担，应用层不再重复判断（恒真分支已删）
      expect(jobs.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'enabled' } }),
      );
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(3);
    });

    it('cron 表达式非法（理论仅手改库）：跳过注册并置 disabled', async () => {
      jobs.find.mockResolvedValue([
        makeJob({ cronExpression: 'not-a-cron', id: '9' }),
      ]);

      await service.onModuleInit();

      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
      expect(jobs.update).toHaveBeenCalledWith(
        { id: '9' },
        { status: 'disabled' },
      );
    });
  });

  describe('create', () => {
    it('合法任务：入库 + 启用即注册调度 + 审计 job.create', async () => {
      const saved = makeJob();
      jobs.save.mockResolvedValue(saved);

      const result = await service.create(
        {
          name: 'cleanup-refresh-tokens',
          actionCode: 'cleanup:refresh-tokens',
          cronExpression: '0 3 * * *',
        },
        OP,
        OP_IP,
      );

      expect(jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'enabled' }),
      );
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'job-1',
        expect.any(CronJob),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.JOB_CREATE,
          operatorId: OP,
          resourceType: 'job',
          resourceId: '1',
          detail: {
            name: 'cleanup-refresh-tokens',
            actionCode: 'cleanup:refresh-tokens',
          },
          ip: OP_IP,
        }),
      );
      expect(result.id).toBe('1');
    });

    it('cron 表达式非法 → 400（不落库、不审计）', async () => {
      await expect(
        service.create(
          {
            name: 'bad',
            actionCode: 'cleanup:refresh-tokens',
            cronExpression: 'not-a-cron',
          },
          OP,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(jobs.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('任务名重复（23505）→ 409（不审计）', async () => {
      jobs.save.mockRejectedValue({ driverError: { code: '23505' } });

      await expect(
        service.create(
          {
            name: 'dup',
            actionCode: 'cleanup:refresh-tokens',
            cronExpression: '0 3 * * *',
          },
          OP,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('非唯一约束错误 → 原样抛出（不误映射 409）', async () => {
      jobs.save.mockRejectedValue(new Error('connection refused'));

      await expect(
        service.create(
          {
            name: 'x',
            actionCode: 'cleanup:refresh-tokens',
            cronExpression: '0 3 * * *',
          },
          OP,
        ),
      ).rejects.toThrow('connection refused');
    });
  });

  describe('update / updateStatus / remove（热更新）', () => {
    it('改 cron：删旧注册 + 重新注册 + 审计 job.update（只记变更字段）', async () => {
      jobs.findOneBy.mockResolvedValue(makeJob());
      jobs.save.mockResolvedValue(makeJob({ cronExpression: '0 4 * * *' }));

      await service.update('1', { cronExpression: '0 4 * * *' }, OP, OP_IP);

      expect(jobs.save).toHaveBeenCalledWith(
        expect.objectContaining({ cronExpression: '0 4 * * *' }),
      );
      // refreshRegistration：删旧（幂等，抛错被吞）+ 注册新
      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('job-1');
      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'job-1',
        expect.any(CronJob),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.JOB_UPDATE,
          operatorId: OP,
          resourceId: '1',
          detail: { changed: ['cronExpression'] },
          ip: OP_IP,
        }),
      );
    });

    it('停用：注销调度，不重新注册 + 审计 job.status.update（from/to）', async () => {
      jobs.findOneBy.mockResolvedValue(makeJob());
      jobs.save.mockResolvedValue(makeJob({ status: 'disabled' }));

      await service.updateStatus('1', { status: 'disabled' }, OP, OP_IP);

      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('job-1');
      expect(schedulerRegistry.addCronJob).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.JOB_STATUS_UPDATE,
          operatorId: OP,
          detail: { from: 'enabled', to: 'disabled' },
          ip: OP_IP,
        }),
      );
    });

    it('启用：注销旧 + 重新注册', async () => {
      jobs.findOneBy.mockResolvedValue(makeJob({ status: 'disabled' }));
      jobs.save.mockResolvedValue(makeJob({ status: 'enabled' }));

      await service.updateStatus('1', { status: 'enabled' }, OP);

      expect(schedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'job-1',
        expect.any(CronJob),
      );
    });

    it('删除：删行 + 注销调度（注销失败容错）+ 审计 job.delete', async () => {
      jobs.findOneBy.mockResolvedValue(makeJob());

      await service.remove('1', OP, OP_IP);

      expect(jobs.delete).toHaveBeenCalledWith({ id: '1' });
      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('job-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.JOB_DELETE,
          operatorId: OP,
          resourceType: 'job',
          resourceId: '1',
          detail: {
            name: 'cleanup-refresh-tokens',
            actionCode: 'cleanup:refresh-tokens',
          },
          ip: OP_IP,
        }),
      );
    });

    it('任务不存在 → 404（不审计）', async () => {
      await expect(service.remove('999', OP)).rejects.toThrow('任务不存在');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('改名撞唯一约束（23505）→ 409（不审计）', async () => {
      jobs.findOneBy.mockResolvedValue(makeJob());
      jobs.save.mockRejectedValue({ driverError: { code: '23505' } });

      await expect(
        service.update('1', { name: 'dup' }, OP),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('执行（run / runAction）', () => {
    it('手动执行成功：调动作方法 + 写 success 执行日志 + 审计 job.run', async () => {
      jobs.findOneBy.mockResolvedValue(makeJob());

      const result = await service.run('1', OP, OP_IP);

      expect(cleanupService.cleanExpiredRefreshTokens).toHaveBeenCalledTimes(1);
      expect(jobRuns.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success', errorMessage: null }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AUDIT_ACTIONS.JOB_RUN,
          operatorId: OP,
          resourceType: 'job',
          resourceId: '1',
          detail: {
            name: 'cleanup-refresh-tokens',
            actionCode: 'cleanup:refresh-tokens',
          },
          ip: OP_IP,
        }),
      );
      expect(result.status).toBe('success');
    });

    it('动作失败：写 failed 执行日志 + 失败原因，不抛出（仍审计）', async () => {
      jobs.findOneBy.mockResolvedValue(makeJob());
      cleanupService.cleanExpiredRefreshTokens.mockRejectedValue(
        new Error('db down'),
      );

      const result = await service.run('1', OP);

      expect(jobRuns.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          errorMessage: 'db down',
        }),
      );
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('failed');
      expect(result.errorMessage).toBe('db down');
    });

    it('未知动作码（理论不可达）：置 disabled + 停调度防重放 + 写 failed 日志', async () => {
      jobs.findOneBy.mockResolvedValue(makeJob({ actionCode: 'hack:run' }));

      const result = await service.run('1', OP);

      expect(jobs.update).toHaveBeenCalledWith(
        { id: '1' },
        { status: 'disabled' },
      );
      // 置 disabled 同时必须停调度：否则下一次 cron tick 照常触发，
      // 每周期重复 disable + 写 failed，"防重放"不成立
      expect(schedulerRegistry.deleteCronJob).toHaveBeenCalledWith('job-1');
      expect(jobRuns.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
      expect(result.status).toBe('failed');
      expect(result.errorMessage).toContain('未知动作码');
    });

    it('cron 触发回调：任务已被删除 → 跳过（不写日志）', async () => {
      jobs.find.mockResolvedValue([makeJob()]);
      jobs.findOneBy.mockResolvedValue(null);

      await service['onModuleInit']();
      // mock.calls 的元素是 any[]：先整体断言为元组再取第 2 位，避免 no-unsafe-member-access
      const firstCall = schedulerRegistry.addCronJob.mock
        .calls[0] as unknown as [string, CronJob];
      const instance = firstCall[1];
      await new Promise<void>((resolvePromise) => {
        // fireOnTick 同步触发回调（回调内 async 由 handleCronTick 自处理），
        // 返回值类型不稳定（cron 包类型定义），void 显式忽略
        void instance.fireOnTick();
        setTimeout(() => resolvePromise(), 0);
      });

      expect(jobRuns.save).not.toHaveBeenCalled();
    });

    it('cron 回调：任务已 disabled（调度未停的兜底场景）→ 跳过执行', async () => {
      jobs.find.mockResolvedValue([makeJob()]);
      // DB 侧已被置 disabled 但调度仍注册（异常/手改库场景）：入口校验 status 拦截
      jobs.findOneBy.mockResolvedValue(makeJob({ status: 'disabled' }));

      await service['onModuleInit']();
      const firstCall = schedulerRegistry.addCronJob.mock
        .calls[0] as unknown as [string, CronJob];
      const instance = firstCall[1];
      await new Promise<void>((resolvePromise) => {
        void instance.fireOnTick();
        setTimeout(() => resolvePromise(), 0);
      });

      // 不执行动作、不写执行日志（跳过）
      expect(cleanupService.cleanExpiredRefreshTokens).not.toHaveBeenCalled();
      expect(jobRuns.save).not.toHaveBeenCalled();
    });

    it('cron 回调：findOneBy 抛错（DB 瞬断）不产生 unhandled rejection', async () => {
      jobs.find.mockResolvedValue([makeJob()]);
      // findOneBy 抛错：handleCronTick 已整体 try/catch——若未吞掉，
      // jest 会把 unhandled rejection 报为本用例失败（本用例通过即证明不冒泡）
      jobs.findOneBy.mockRejectedValue(new Error('connection lost'));

      await service['onModuleInit']();
      const firstCall = schedulerRegistry.addCronJob.mock
        .calls[0] as unknown as [string, CronJob];
      const instance = firstCall[1];
      await new Promise<void>((resolvePromise) => {
        void instance.fireOnTick();
        setTimeout(() => resolvePromise(), 0);
      });

      expect(jobRuns.save).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('执行日志写入失败：仅记 error，不抛出', async () => {
      jobs.findOneBy.mockResolvedValue(makeJob());
      jobRuns.save.mockRejectedValue(new Error('log db down'));

      await expect(service.run('1', OP)).resolves.toMatchObject({
        status: 'success',
      });
    });
  });

  describe('list / listRuns', () => {
    it('任务列表：双键稳定排序 + 状态筛选', async () => {
      await service.list({ page: 2, pageSize: 5, status: 'enabled' });

      expect(jobs.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'enabled' },
          order: { createdAt: 'DESC', id: 'DESC' },
          skip: 5,
          take: 5,
        }),
      );
    });

    it('执行日志：按任务 + (started_at, id) 排序', async () => {
      jobs.findOneBy.mockResolvedValue(makeJob());

      await service.listRuns('1', { status: 'success' });

      expect(jobRuns.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { jobId: '1', status: 'success' },
          order: { startedAt: 'DESC', id: 'DESC' },
        }),
      );
    });

    it('执行日志：任务不存在 → 404', async () => {
      await expect(service.listRuns('999', {})).rejects.toThrow('任务不存在');
    });
  });
});
