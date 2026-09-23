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
 * 登录日志：登录接口的每次成功/失败尝试。
 * 设计要点：
 * - account 只存**脱敏后**账号（maskAccount），不落 PII 明文（与 pino 日志同口径）；
 *   追踪靠 user_id（失败且无用户时为空）+ created_at 时间线；
 * - user_id 用 SET NULL 外键：用户被删后登录日志保留审计价值，仅断开关联；
 * - 只记"登录"事件（register/refresh 不算登录，不写本表）；
 *   刷新令牌的签发/撤销由 refresh_tokens 与 audit_logs 覆盖。
 */
@Entity('login_logs')
// 单列 created_at 索引已删除（迁移与实体同步）：idx_login_logs_created_id 复合
// 索引前缀覆盖单列查询，避免 append-only 表的冗余 B-tree 维护
@Index('idx_login_logs_user', ['userId'])
@Index('idx_login_logs_success_created', ['success', 'createdAt'])
// 与 InitAudit 迁移一致：匹配 (createdAt, id) 双键稳定排序（同时间戳多行时
// offset 分页不重复/不遗漏）；迁移建 ASC，PG 对倒序查询走 backward scan
@Index('idx_login_logs_created_id', ['createdAt', 'id'])
export class LoginLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /**
   * 关联用户（登录成功/账号存在时）；SET NULL 外键（用户删除后保留审计）。
   * 必须声明关系（不能裸 @Column）：让 TypeORM 迁移对比知道此列带外键约束——
   * 否则下次 migration:generate 会把迁移里裸 SQL 建的外键 DROP 掉且不再重建
   * （审计两实体曾是唯一破坏此惯例的例外，已修复；写法与 refresh-token 同款）。
   */
  @Column({ name: 'user_id', type: 'bigint', nullable: true })
  userId: string | null;

  /** 关联用户（与 userId 共用同一列；onDelete SET NULL 由数据库层保证） */
  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  // foreignKeyConstraintName 显式对齐迁移里的裸 SQL 约束名（FK_login_logs_user）：
  // 不声明则 TypeORM 用 hash 名，已迁移库上 schema:log/generate 会计划 DROP+重建该外键
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_login_logs_user',
  })
  user: User | null;

  /** 登录输入的账号（已脱敏） */
  @Column({ name: 'account', type: 'varchar', length: 255, nullable: true })
  account: string | null;

  /** 是否成功 */
  @Column({ type: 'boolean', default: false })
  success: boolean;

  /** 失败原因（仅失败时）：invalid_credentials / account_disabled */
  @Column({ name: 'fail_reason', type: 'varchar', length: 50, nullable: true })
  failReason: string | null;

  /** 客户端 IP（已按 TRUST_PROXY 解析，非原始 X-Forwarded-For） */
  @Column({ name: 'ip', type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  /** 客户端 UA（截断 255） */
  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
