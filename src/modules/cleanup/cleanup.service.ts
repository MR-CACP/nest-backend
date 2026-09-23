import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FindOptionsOrder,
  FindOptionsSelect,
  FindOptionsWhere,
  LessThan,
  Repository,
} from 'typeorm';

import type { CleanupConfig } from '../../config/types';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { LoginLog } from '../audit/entities/login-log.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { JobRun } from '../jobs/entities/job-run.entity';

/** 单批删除上限：避免大表一次性长事务阻塞写入（模板级数据量下 1-2 批即完成） */
const BATCH_SIZE = 1000;

/**
 * 定时清理服务：删除过期/超保留期行，阻止 append-only 表无界增长
 * （refresh_tokens 只增不清、审计表无保留策略——多轮审查点名的技术债）。
 * 调度方式：本服务只暴露"动作方法"，**不再持有 @Cron 装饰器**——
 * 由 jobs 模块按 job_definitions 表动态注册（若依式调度中心），
 * 动作码 cleanup:refresh-tokens / cleanup:audit-logs / cleanup:job-runs。
 * 设计取舍：
 * - 清理只删"过期超过保留期"的行：保留期内撤销/过期时间仍有审计价值，
 *   在线判定（revoked_at IS NULL 且未过期）不受影响；
 * - 分批删除（先查 id 再按 id 删）规避 PG DELETE 无 LIMIT 的长事务问题；
 * - 幂等且无业务副作用：多副本部署重复执行只会删 0 行（未加分布式锁，
 *   对单应用模板是刻意简化，注释在此）；
 * - **错误向上抛、不内部吞**：清理的"尽力而为"语义由调度层保证——
 *   jobs.runAction 的 try/catch 会把动作错误记 error + 写 failed 执行日志后吞掉。
 *   若本服务在这里 catch 后 resolve，runAction 永远判定 success，job_runs 全绿
 *   而清理早已失效（曾因此把 failed 分支变成死代码，见多轮审查）。
 */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(LoginLog)
    private readonly loginLogs: Repository<LoginLog>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    @InjectRepository(JobRun)
    private readonly jobRuns: Repository<JobRun>,
  ) {}

  /** 动作 cleanup:refresh-tokens：删除过期超过保留期的 refresh token 行（默认 30 天）。
   *  错误不在此吞：向上抛给调度层（jobs.runAction）统一记 error + 写 failed 执行日志 */
  async cleanExpiredRefreshTokens(): Promise<void> {
    const cfg = this.configService.getOrThrow<CleanupConfig>('cleanup');
    const cutoff = this.cutoffDate(cfg.refreshTokenRetentionDays);
    const deleted = await this.deleteInBatches(this.refreshTokens, {
      expiresAt: LessThan(cutoff),
    });
    this.logger.log(
      `清理 refresh_tokens：删除 ${deleted} 行（保留期 ${cfg.refreshTokenRetentionDays} 天，截止 ${cutoff.toISOString()}）`,
    );
  }

  /** 动作 cleanup:audit-logs：login_logs / audit_logs 删除超过保留期的行（默认 180 天） */
  async cleanAuditLogs(): Promise<void> {
    const cfg = this.configService.getOrThrow<CleanupConfig>('cleanup');
    const cutoff = this.cutoffDate(cfg.auditRetentionDays);
    const loginDeleted = await this.deleteInBatches(this.loginLogs, {
      createdAt: LessThan(cutoff),
    });
    const auditDeleted = await this.deleteInBatches(this.auditLogs, {
      createdAt: LessThan(cutoff),
    });
    this.logger.log(
      `清理审计表：login_logs 删除 ${loginDeleted} 行、audit_logs 删除 ${auditDeleted} 行（保留期 ${cfg.auditRetentionDays} 天，截止 ${cutoff.toISOString()}）`,
    );
  }

  /** 动作 cleanup:job-runs：job_runs 执行日志删除超过保留期的行（复用审计保留期） */
  async cleanJobRuns(): Promise<void> {
    const cfg = this.configService.getOrThrow<CleanupConfig>('cleanup');
    const cutoff = this.cutoffDate(cfg.auditRetentionDays);
    const deleted = await this.deleteInBatches(this.jobRuns, {
      startedAt: LessThan(cutoff),
    });
    this.logger.log(
      `清理 job_runs：删除 ${deleted} 行（保留期 ${cfg.auditRetentionDays} 天，截止 ${cutoff.toISOString()}）`,
    );
  }

  /** 分批删除：先查 id（take=BATCH_SIZE）再按 id 删，循环直到无剩余；
   *  单批影响行数有界，长事务/大锁风险可控 */
  private async deleteInBatches<T extends { id: string }>(
    repo: Repository<T>,
    criteria: FindOptionsWhere<T>,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await repo.find({
        where: criteria,
        // 泛型方法里 TS 无法静态验证 T 的具体键，实体均为主键 id，断言是安全的
        select: { id: true } as FindOptionsSelect<T>,
        // 按主键排序：分批读取稳定（无序 LIMIT 在边删边查时可能游标漂移漏行）
        // 泛型 T 未约束 id 键，与 select 同款断言（实体均为主键 id）
        order: { id: 'ASC' } as FindOptionsOrder<T>,
        take: BATCH_SIZE,
      });
      if (rows.length === 0) break;
      await repo.delete(rows.map((r) => r.id));
      total += rows.length;
      if (rows.length < BATCH_SIZE) break;
    }
    return total;
  }

  /** 截止时间 = now - 保留天数（用应用时钟，与数据库时钟解耦，测试可注入确定性时间） */
  private cutoffDate(retentionDays: number): Date {
    return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  }
}
