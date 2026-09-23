import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { Repository } from 'typeorm';

import { AUDIT_ACTIONS } from '../../common/constants/audit.constants';
import { JobActionCode } from '../../common/constants/job.constants';
import { isUniqueViolation, truncate } from '../../common/utils/account';
import { AuditService } from '../audit/audit.service';
import { CleanupService } from '../cleanup/cleanup.service';
import {
  CreateJobDto,
  ListJobRunsQuery,
  ListJobsQuery,
  UpdateJobDto,
  UpdateJobStatusDto,
} from './dto/job.dto';
import { JobDefinition } from './entities/job-definition.entity';
import { JobRun } from './entities/job-run.entity';

/** SchedulerRegistry 中的注册名：job-<id>（id 稳定，改名不影响注册；防与用户任务名冲突） */
const jobRegistryName = (id: string): string => `job-${id}`;

/**
 * 定时任务服务：若依式"任务定义存库 + 运行时动态调度"。
 * 职责：
 * - 启动时把 enabled 任务注册进 SchedulerRegistry（@Cron 静态装饰器的动态替代）；
 * - 管理端 CRUD + 启停 + 手动执行（热更新注册，改配置无需重启）；
 * - 每次执行（cron 触发或手动 run）写 job_runs 执行日志。
 * 设计取舍：
 * - 动作码 → 执行函数映射集中在 actionRunners（JOB_ACTIONS 只登记清单，
 *   避免 constants 反向依赖服务模块）；
 * - 注册失败（cron 非法，理论只可能手改库出现）记 error 并置 disabled 自我修复，
 *   不让单个脏数据拖垮整个应用启动；
 * - 多副本部署：每副本各自注册执行，同一任务可能被多次执行——
 *   cleanup 类动作幂等（重复执行删 0 行），手动 run 属管理员显式操作；
 * - job_runs 只增不清：由 cleanup:job-runs 任务按保留期清理。
 */
@Injectable()
export class JobService implements OnModuleInit {
  private readonly logger = new Logger(JobService.name);

  /** 动作码 → 执行函数（唯一执行映射；新增动作在此挂函数 + JOB_ACTIONS 登记） */
  private readonly actionRunners: Record<JobActionCode, () => Promise<void>> = {
    'cleanup:refresh-tokens': () =>
      this.cleanupService.cleanExpiredRefreshTokens(),
    'cleanup:audit-logs': () => this.cleanupService.cleanAuditLogs(),
    'cleanup:job-runs': () => this.cleanupService.cleanJobRuns(),
  };

  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly cleanupService: CleanupService,
    private readonly auditService: AuditService,
    @InjectRepository(JobDefinition)
    private readonly jobs: Repository<JobDefinition>,
    @InjectRepository(JobRun)
    private readonly jobRuns: Repository<JobRun>,
  ) {}

  /** 启动时加载全部 enabled 任务注册进调度器（DB 驱动的 cron 注册） */
  async onModuleInit(): Promise<void> {
    const enabledJobs = await this.jobs.find({ where: { status: 'enabled' } });
    for (const job of enabledJobs) {
      // find 已带 where:{status:'enabled'}，返回必然 enabled，直接注册
      this.registerJob(job);
    }
    this.logger.log(`已注册 ${enabledJobs.length} 个定时任务`);
  }

  // ---------- 查询 ----------

  /** 任务定义分页列表（(created_at, id) 双键稳定排序） */
  async list(query: ListJobsQuery): Promise<{
    items: JobDefinition[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 10;
    const [items, total] = await this.jobs.findAndCount({
      where: query.status ? { status: query.status } : {},
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }

  /** 指定任务的执行日志分页（任务不存在 404；(started_at, id) 双键稳定排序） */
  async listRuns(
    jobId: string,
    query: ListJobRunsQuery,
  ): Promise<{
    items: JobRun[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    await this.requireJob(jobId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 10;
    const [items, total] = await this.jobRuns.findAndCount({
      where: {
        jobId,
        ...(query.status ? { status: query.status } : {}),
      },
      order: { startedAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }

  // ---------- 写路径 ----------

  /** 创建任务：校验 cron/动作码 → 入库 → 启用则注册（热生效） */
  async create(
    dto: CreateJobDto,
    operatorId: string,
    ip?: string,
  ): Promise<JobDefinition> {
    this.assertCronExpression(dto.cronExpression);
    const job = this.jobs.create({
      name: dto.name,
      actionCode: dto.actionCode,
      cronExpression: dto.cronExpression,
      status: dto.status ?? 'enabled',
      remark: dto.remark ?? null,
    });
    try {
      const saved = await this.jobs.save(job);
      if (saved.status === 'enabled') {
        this.registerJob(saved);
      }
      // 管理操作审计（尽力而为）：创建任务属敏感配置变更
      await this.auditService.record({
        action: AUDIT_ACTIONS.JOB_CREATE,
        operatorId,
        resourceType: 'job',
        resourceId: saved.id,
        detail: { name: saved.name, actionCode: saved.actionCode },
        ip,
      });
      return saved;
    } catch (err) {
      // 同名任务并发/已存在 → 23505 唯一约束 → 409（与 auth/users 同款映射）
      if (isUniqueViolation(err)) {
        throw new ConflictException('任务名已存在');
      }
      throw err;
    }
  }

  /** 部分更新：undefined 不覆盖；cron 变更后热更新注册 */
  async update(
    id: string,
    dto: UpdateJobDto,
    operatorId: string,
    ip?: string,
  ): Promise<JobDefinition> {
    const job = await this.requireJob(id);
    if (dto.name !== undefined) job.name = dto.name;
    if (dto.actionCode !== undefined) job.actionCode = dto.actionCode;
    if (dto.cronExpression !== undefined) {
      this.assertCronExpression(dto.cronExpression);
      job.cronExpression = dto.cronExpression;
    }
    if (dto.remark !== undefined) job.remark = dto.remark ?? null;
    try {
      const saved = await this.jobs.save(job);
      // cron/动作码变更都影响运行行为：统一走"删注册 + 按当前状态重新注册"
      this.refreshRegistration(saved);
      // 管理操作审计：只记变更字段名（PATCH 部分更新；undefined 键由 ValidationPipe
      // 注入为自有属性，需过滤后再取键——与 users.update 同款口径）
      const changed = Object.entries(dto)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key);
      await this.auditService.record({
        action: AUDIT_ACTIONS.JOB_UPDATE,
        operatorId,
        resourceType: 'job',
        resourceId: saved.id,
        detail: { changed },
        ip,
      });
      return saved;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('任务名已存在');
      }
      throw err;
    }
  }

  /** 启停：状态变更立即生效（enabled 注册/start，disabled 停用） */
  async updateStatus(
    id: string,
    dto: UpdateJobStatusDto,
    operatorId: string,
    ip?: string,
  ): Promise<JobDefinition> {
    const job = await this.requireJob(id);
    const from = job.status;
    job.status = dto.status;
    const saved = await this.jobs.save(job);
    this.refreshRegistration(saved);
    // 管理操作审计：启停直接影响生产调度（停用每日清理 = 敏感变更）
    await this.auditService.record({
      action: AUDIT_ACTIONS.JOB_STATUS_UPDATE,
      operatorId,
      resourceType: 'job',
      resourceId: saved.id,
      detail: { from, to: dto.status },
      ip,
    });
    return saved;
  }

  /** 删除任务：删 DB 行 + 注销调度（执行日志经 FK SET NULL 保留） */
  async remove(id: string, operatorId: string, ip?: string): Promise<void> {
    const job = await this.requireJob(id);
    await this.jobs.delete({ id });
    try {
      this.schedulerRegistry.deleteCronJob(jobRegistryName(id));
    } catch {
      // 未注册（disabled 任务从未注册）——注销是尽力而为
    }
    // 管理操作审计：删任务前先取定义（requireJob），detail 记名称/动作码供追溯
    await this.auditService.record({
      action: AUDIT_ACTIONS.JOB_DELETE,
      operatorId,
      resourceType: 'job',
      resourceId: id,
      detail: { name: job.name, actionCode: job.actionCode },
      ip,
    });
  }

  /** 手动执行一次：返回本次执行结果（失败不抛——结果已写执行日志，接口透出给前端展示） */
  async run(
    id: string,
    operatorId: string,
    ip?: string,
  ): Promise<{
    jobId: string;
    name: string;
    status: 'success' | 'failed';
    durationMs: number;
    errorMessage: string | null;
  }> {
    const job = await this.requireJob(id);
    const result = await this.runAction(job);
    // 管理操作审计：手动执行立即触发生产动作（跳过 cron 等待），属敏感操作
    await this.auditService.record({
      action: AUDIT_ACTIONS.JOB_RUN,
      operatorId,
      resourceType: 'job',
      resourceId: job.id,
      detail: { name: job.name, actionCode: job.actionCode },
      ip,
    });
    return {
      jobId: job.id,
      name: job.name,
      status: result.status,
      durationMs: result.durationMs,
      errorMessage: result.errorMessage,
    };
  }

  // ---------- 内部实现 ----------

  /** cron 触发回调：任务可能已被删除/停用（理论不可达，容错跳过）。整体 try/catch：
   * findOneBy 的 DB 错误（连接瞬断等）不能让调用点 `void this.handleCronTick(...)`
   * 产生 unhandled rejection（Node 默认 crash 进程）——记 error 后吞掉 */
  private async handleCronTick(jobId: string): Promise<void> {
    try {
      const job = await this.jobs.findOneBy({ id: jobId });
      if (!job) {
        this.logger.warn(`定时任务 ${jobId} 已不存在，跳过本次触发`);
        return;
      }
      // 兜底防线：DB 侧已置 disabled 但调度未停（如未知动作码自愈路径）时不再执行——
      // 防"每周期重复 disable + 写 failed"的重放；正常启停路径 refreshRegistration
      // 已删注册，此处只兜异常/手改库场景
      if (job.status !== 'enabled') {
        this.logger.warn(`定时任务 ${jobId} 已停用，跳过本次触发`);
        return;
      }
      await this.runAction(job);
    } catch (err) {
      this.logger.error(
        `定时任务 ${jobId} 触发处理失败：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 执行动作 + 写执行日志（cron 触发与手动 run 共用；动作本身抛错被吞，记录为 failed） */
  private async runAction(job: JobDefinition): Promise<{
    status: 'success' | 'failed';
    durationMs: number;
    errorMessage: string | null;
  }> {
    const startedAt = new Date();
    const runner = this.actionRunners[job.actionCode as JobActionCode];
    if (!runner) {
      // 动作码不在映射表（JOB_ACTIONS 已拦，理论不可达）：记 failed 并置 disabled 防重放
      const message = `未知动作码 ${job.actionCode}`;
      this.logger.error(
        `任务 ${job.name}（id=${job.id}）：${message}，已置为 disabled`,
      );
      await this.jobs.update({ id: job.id }, { status: 'disabled' });
      // 置 disabled 的同时必须停调度：否则下一次 cron tick 照常触发，
      // 每周期重复"disable（无操作）+ 写 failed 日志"，防重放并不成立
      try {
        this.schedulerRegistry.deleteCronJob(jobRegistryName(job.id));
      } catch {
        // 未注册（理论不可达）——尽力而为
      }
      await this.recordRun(job.id, 'failed', startedAt, message);
      return { status: 'failed', durationMs: 0, errorMessage: message };
    }
    try {
      await runner();
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      await this.recordRun(job.id, 'success', startedAt, null, durationMs);
      return { status: 'success', durationMs, errorMessage: null };
    } catch (err) {
      const finishedAt = new Date();
      // 失败同样计算真实耗时：诊断"慢失败"（DB 假死/锁等待）时耗时是最有用的信号，
      // 0/NULL 会丢掉它
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const message = truncate(
        err instanceof Error ? err.message : String(err),
        500,
      );
      this.logger.error(`任务 ${job.name}（id=${job.id}）执行失败：${message}`);
      await this.recordRun(job.id, 'failed', startedAt, message, durationMs);
      return { status: 'failed', durationMs, errorMessage: message };
    }
  }

  /** 写执行日志（job_runs 追加一行；写入失败仅记 error——执行日志丢失不应影响任务本身） */
  private async recordRun(
    jobId: string,
    status: 'success' | 'failed',
    startedAt: Date,
    errorMessage: string | null,
    durationMs?: number,
  ): Promise<void> {
    try {
      await this.jobRuns.save({
        jobId,
        status,
        startedAt,
        finishedAt: new Date(),
        durationMs: durationMs ?? null,
        errorMessage,
      });
    } catch (err) {
      this.logger.error(
        `写入执行日志失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 注册任务到调度器：CronJob 构造即校验表达式；失败置 disabled 自我修复 */
  private registerJob(job: JobDefinition): void {
    // 只捕获 id 而非整个实体：CronJob 闭包在调度器生命周期内常驻，
    // 捕获整行（name/cron/remark/时间戳）是无谓的内存占用
    const id = job.id;
    try {
      const cronJob = new CronJob(job.cronExpression, () => {
        // 回调内 await 的 Promise 错误已在 runAction 内处理，这里仅触发执行
        void this.handleCronTick(id);
      });
      this.schedulerRegistry.addCronJob(jobRegistryName(id), cronJob);
      cronJob.start();
      this.logger.log(
        `已注册任务 ${job.name}（${job.cronExpression}，id=${job.id}）`,
      );
    } catch (err) {
      // 表达式非法只可能来自手改库（DTO/服务层已双重校验）；置 disabled 避免每次重启重试
      this.logger.error(
        `任务 ${job.name}（id=${job.id}）cron 表达式非法，已置为 disabled：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      void this.jobs
        .update({ id }, { status: 'disabled' })
        .catch(() => undefined);
      // 表达式非法时 CronJob 构造失败、从未注册成功，deleteCronJob 必然抛
      // NotFound 被吞（幂等）——保留是与"置 disabled 即停调度"的统一口径
      try {
        this.schedulerRegistry.deleteCronJob(jobRegistryName(id));
      } catch {
        // 未注册——尽力而为
      }
    }
  }

  /** 热更新：删旧注册（幂等）→ 按当前状态重新注册 */
  private refreshRegistration(job: JobDefinition): void {
    try {
      this.schedulerRegistry.deleteCronJob(jobRegistryName(job.id));
    } catch {
      // 未注册（从未启用或已删除）——删注册是尽力而为
    }
    if (job.status === 'enabled') {
      this.registerJob(job);
    }
  }

  /** cron 表达式合法性校验（cron 包构造即解析，非法即抛；回调占位不会被触发） */
  private assertCronExpression(expression: string): void {
    try {
      new CronJob(expression, () => undefined);
    } catch {
      throw new BadRequestException('cron 表达式非法');
    }
  }

  /** 任务存在性校验（404 兜底，避免非数字/不存在 id 打到空指针） */
  private async requireJob(id: string): Promise<JobDefinition> {
    const job = await this.jobs.findOneBy({ id });
    if (!job) {
      throw new NotFoundException('任务不存在');
    }
    return job;
  }
}
