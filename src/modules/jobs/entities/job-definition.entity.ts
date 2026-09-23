import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 定时任务定义（job_definitions）：若依式"任务存库 + 动态调度"的数据模型。
 * 设计要点：
 * - 任务 = 动作码（映射到服务方法）+ cron 表达式 + 启停状态，全部可页面维护，
 *   改配置无需改代码重启（对比 @Cron 静态装饰器）；
 * - status 启用/禁用双态：禁用任务不注册进 SchedulerRegistry（不触发）。
 *   枚举合法性由 DTO @IsIn + 服务层保证（不加 DB CHECK——TypeORM @Check 约束名
 *   是哈希值，迁移手写会与实体漂移；写路径全部经过校验层，纵深防御可省略）；
 * - name 唯一（页面展示 + 幂等种子的判重依据）；
 * - 列表分页按 (created_at, id) 双键稳定排序——表量级小（任务数封顶），
 *   不建分页索引，全表扫可接受。
 */
@Entity('job_definitions')
@Index('idx_job_definitions_status', ['status'])
export class JobDefinition {
  /** 主键：bigserial（返回 string，见 User.id） */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** 任务名（页面展示；唯一，用于幂等种子判重） */
  @Column({ type: 'varchar', length: 100, unique: true })
  name: string;

  /** 动作码：JOB_ACTIONS 常量清单的 key（唯一真源，见 common/constants/job.constants.ts） */
  @Column({ name: 'action_code', type: 'varchar', length: 50 })
  actionCode: string;

  /** cron 表达式（cron 包 5/6 段格式）；DTO/服务层双重校验，库内理论恒合法 */
  @Column({ name: 'cron_expression', type: 'varchar', length: 100 })
  cronExpression: string;

  /** 启停状态：enabled 启动时注册进 SchedulerRegistry；disabled 仅保留定义 */
  @Column({ type: 'varchar', length: 20, default: 'enabled' })
  status: 'enabled' | 'disabled';

  /** 备注（可选） */
  @Column({ type: 'varchar', length: 255, nullable: true })
  remark: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
