import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { User } from '../../auth/entities/user.entity';
import { Role } from './role.entity';

/**
 * 用户-角色关联实体（user_roles 表）：用户与角色是多对多。
 * 设计要点：
 * - 显式实体而非仅 JoinTable：管理端需要按用户/按角色查询与增删分配，
 *   隐式连接表无法直接 CRUD；
 * - 联合主键 (user_id, role_id)：同一用户同一角色不会重复分配；
 * - 无软删：取消分配 = 删行（审计由后续审计表承载）；
 * - FK 均 ON DELETE CASCADE：删除用户/角色时关联自动清理。
 */
@Entity('user_roles')
export class UserRole {
  /** 用户 ID（联合主键之一，FK → users.id） */
  @PrimaryColumn({ name: 'user_id', type: 'bigint' })
  userId: string;

  /** 角色 ID（联合主键之一，FK → roles.id） */
  @PrimaryColumn({ name: 'role_id', type: 'bigint' })
  roleId: string;

  /** 分配时间（TypeORM 自动填充） */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** 关联用户（管理端"按用户查角色"用） */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  /** 关联角色（管理端"按角色查用户"用） */
  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id' })
  role?: Role;
}
