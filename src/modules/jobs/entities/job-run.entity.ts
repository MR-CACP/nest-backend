import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { JobDefinition } from './job-definition.entity';

/**
 * 任务执行日志（job_runs）：每次执行（cron 触发或手动 run）追加一行。
 * 设计要点：
 * - 记录开始/结束时刻与耗时、成功/失败状态与失败原因——"调度日志"页面的数据源；
 * - job_id 外键 ON DELETE SET NULL：任务删除后执行历史保留（审计完整性，与 audit_logs 同款）；
 * - 只增不清：由 cleanup 模块的 cleanup:job-runs 动作按保留期清理（闭环）。
 */
@Entity('job_runs')
// (job_id, started_at, id) 复合索引：按任务查执行日志 + (started_at DESC, id DESC) 稳定分页
@Index('idx_job_runs_job_started_id', ['jobId', 'startedAt', 'id'])
// (started_at, id) 前导索引：cleanup:job-runs 按 started_at < cutoff 清老日志——
// job_id 是上一索引首列，该条件无法命中；本索引同时服务稳定分批排序
@Index('idx_job_runs_started_id', ['startedAt', 'id'])
export class JobRun {
  /** 主键：bigserial（返回 string） */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** 所属任务（FK → job_definitions.id，删任务置空保留历史） */
  @Column({ name: 'job_id', type: 'bigint', nullable: true })
  jobId: string | null;

  /** 关联任务（与 jobId 共用同一列；外键约束名与迁移手写 SQL 对齐，防 schema:log 漂移） */
  @ManyToOne(() => JobDefinition, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'job_id',
    foreignKeyConstraintName: 'FK_job_runs_job',
  })
  job: JobDefinition | null;

  /** 执行结果：success / failed */
  @Column({ type: 'varchar', length: 20 })
  status: 'success' | 'failed';

  /** 开始时刻（cron 触发或手动执行的起点） */
  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt: Date;

  /** 结束时刻（成功或失败均写入） */
  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  /** 耗时毫秒（结束时刻 - 开始时刻） */
  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs: number | null;

  /** 失败原因（截断到列宽 500；成功为 NULL） */
  @Column({
    name: 'error_message',
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  errorMessage: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
