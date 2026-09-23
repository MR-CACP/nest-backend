import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from './user.entity';

/**
 * 刷新令牌实体（refresh_tokens 表）：refresh token 会话记录，
 * 同时是管理端"在线列表"的数据源。
 * 设计要点：
 * - token_hash 存 SHA-256 哈希而非明文，数据库泄露无法直接冒用令牌；
 * - 强制下线 = 写入 revoked_at（不物理删除，保留审计）；
 * - 过期令牌由 expires_at 判定，配合 (user_id, revoked_at) 索引分页查询在线会话。
 */
@Entity('refresh_tokens')
@Index('idx_refresh_tokens_user_revoked', ['userId', 'revokedAt'])
@Index('idx_refresh_tokens_expires', ['expiresAt'])
// 在线列表按 (created_at DESC, id DESC) 分页（见 sessions.service）——排序路径复合索引
@Index('idx_refresh_tokens_created_id', ['createdAt', 'id'])
export class RefreshToken {
  /** 主键：bigserial（返回 string，见 User.id） */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** 所属用户（FK → users.id，删用户级联清会话） */
  @Column({ name: 'user_id', type: 'bigint' })
  userId: string;

  /** 关联用户（与 userId 共用同一列；onDelete CASCADE 由数据库层保证） */
  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** 令牌哈希（SHA-256 十六进制，64 字符） */
  @Column({ name: 'token_hash', type: 'varchar', length: 64, unique: true })
  tokenHash: string;

  /** 过期时间：在线判定的核心依据 */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /** 撤销时间：NULL=在线；强制下线即写入 */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  /** 登录设备信息（在线列表展示用） */
  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  /** 登录 IP（IPv6 最长 45 字符） */
  @Column({ type: 'varchar', length: 45, nullable: true })
  ip: string | null;

  /** 创建时间（=签发时间） */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** 更新时间 */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
