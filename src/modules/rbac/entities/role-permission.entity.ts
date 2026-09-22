import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { Permission } from './permission.entity';
import { Role } from './role.entity';

/**
 * 角色-权限关联实体（role_permissions 表）：角色与权限是多对多。
 * 设计要点：
 * - 显式实体：管理端"按角色配置权限"需要直接增删行；
 * - 联合主键 (role_id, permission_id)：同一权限不会重复绑定；
 * - 无软删：取消绑定 = 删行；
 * - FK 均 ON DELETE CASCADE：删除角色/权限点时关联自动清理。
 */
@Entity('role_permissions')
export class RolePermission {
  /** 角色 ID（联合主键之一，FK → roles.id） */
  @PrimaryColumn({ name: 'role_id', type: 'bigint' })
  roleId: string;

  /** 权限点 ID（联合主键之一，FK → permissions.id） */
  @PrimaryColumn({ name: 'permission_id', type: 'bigint' })
  permissionId: string;

  /** 绑定时间（TypeORM 自动填充） */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** 关联角色 */
  @ManyToOne(() => Role, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'role_id' })
  role?: Role;

  /** 关联权限点 */
  @ManyToOne(() => Permission, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'permission_id' })
  permission?: Permission;
}
