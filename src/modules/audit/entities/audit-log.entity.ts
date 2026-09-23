import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../auth/entities/user.entity';

/**
 * 操作审计：管理端写路径的"谁在何时对什么做了什么"（追加式，不更新不删除）。
 * 设计要点：
 * - 覆盖 users（创建/改资料/改状态/分配角色）、rbac（角色 CRUD/分配权限）、
 *   sessions（单会话/全部下线）、jobs（任务 CRUD/启停/手动执行）的管理写操作；自助操作（register、/me）暂不记
 *   （范围克制，README 注明可扩展）；
 * - operator_id 用 SET NULL 外键：操作者被删后审计仍保留（审计完整性）；
 * - resource_id 不设外键（多态：user/role/session/job 的 id 形态不同），
 *   检索靠 resource_type + resource_id 组合；
 * - detail 存变更摘要（如状态 from→to、分配的 roleIds），不落敏感字段
 *   （密码哈希、refresh 明文等一律不写）。
 */
@Entity('audit_logs')
// 单列 created_at 索引已删除（迁移与实体同步）：idx_audit_logs_created_id 复合
// 索引前缀覆盖单列查询，避免 append-only 表的冗余 B-tree 维护
@Index('idx_audit_logs_operator', ['operatorId'])
@Index('idx_audit_logs_action', ['action'])
// 与 InitAudit 迁移一致（实体缺声明会让 schema:log 计划 DROP 多余索引）：
// (createdAt, id) 匹配双键稳定排序（同时间戳多行时 offset 分页不重复/不遗漏）；
// TypeORM 索引不支持 DESC，迁移建 ASC、PG 对倒序查询走 backward scan，性能等价
@Index('idx_audit_logs_created_id', ['createdAt', 'id'])
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /**
   * 操作者（管理端登录用户）；SET NULL 外键。
   * 必须声明关系（与 login_logs.user_id 同理）：否则 migration:generate
   * 会把迁移里裸 SQL 建的外键 DROP 且不再重建（已修复，见 login-log 注释）。
   */
  @Column({ name: 'operator_id', type: 'bigint', nullable: true })
  operatorId: string | null;

  /** 操作者用户（与 operatorId 共用同一列；onDelete SET NULL 由数据库层保证） */
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  // foreignKeyConstraintName 显式对齐迁移里的裸 SQL 约束名（FK_audit_logs_operator）：
  // 不声明则 TypeORM 用 hash 名，已迁移库上 schema:log/generate 会计划 DROP+重建该外键
  @JoinColumn({
    name: 'operator_id',
    foreignKeyConstraintName: 'FK_audit_logs_operator',
  })
  operator: User | null;

  /** 动作码（点分命名：user.create / role.update / session.revoke_all / job.run） */
  @Column({ name: 'action', type: 'varchar', length: 100 })
  action: string;

  /** 资源类型（user / role / session / job；permission 永不产生——与查询 DTO 的 @IsIn 一致） */
  // 公开筛选条件：单列索引避免追加式日志下的全表扫（与迁移一致）
  @Index('idx_audit_logs_resource_type')
  @Column({ name: 'resource_type', type: 'varchar', length: 50 })
  resourceType: string;

  /** 资源 ID（字符串形态；多态资源，不设外键） */
  @Column({ name: 'resource_id', type: 'varchar', length: 64, nullable: true })
  resourceId: string | null;

  /** 变更摘要（JSONB；不含敏感字段） */
  @Column({ name: 'detail', type: 'jsonb', nullable: true })
  detail: Record<string, unknown> | null;

  /** 操作者 IP（controller 从 req.ip 透传，已按 TRUST_PROXY 解析） */
  @Column({ name: 'ip', type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
