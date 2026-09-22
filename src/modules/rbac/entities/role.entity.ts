import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinTable,
  ManyToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../auth/entities/user.entity';
import { Permission } from './permission.entity';

/**
 * 角色实体（roles 表）：RBAC 的角色定义。
 * 设计要点：
 * - 业务键用 code 不用 name：改名（展示名）不破坏 user_roles 引用；
 * - 软删 + 局部唯一索引（WHERE deleted_at IS NULL）：沿用 users 模式——
 *   软删角色不占用 code，可重建；管理端删除角色前需先解除 user_roles 引用（下阶段 enforce）；
 * - is_system 系统角色（admin/user）不可删除、不可改权限绑定（种子声明，见迁移 InitRbac）；
 * - 与权限的关联经 role_permissions 连接表（本实体维护 JoinTable 侧）；
 * - 与用户的关联经 user_roles 连接表（反向关系由 User 实体维护 JoinTable 侧）。
 * - 所有列显式声明 type：可空联合类型（string | null）无法被反射推断，
 *   否则 TypeORM 报 DataTypeNotSupportedError（与 User 实体同一约定）。
 */
@Entity('roles')
@Index('UQ_roles_code_active', ['code'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
export class Role {
  /** 主键：bigserial。bigint 由 pg 驱动返回 string（避免 JS 精度丢失） */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** 角色业务码（如 admin / user）；局部唯一索引保证软删行不占用 */
  @Column({ type: 'varchar', length: 50 })
  code: string;

  /** 角色展示名（可改名，不改 code） */
  @Column({ type: 'varchar', length: 50 })
  name: string;

  /** 角色说明 */
  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  /**
   * 系统内置标记：true 的角色（admin/user）由种子声明，管理端不可删除、
   * 不可修改权限绑定——权限绑定由代码声明，改了会与代码不一致。
   * 普通角色为 false，可自由分配权限。
   */
  @Column({ name: 'is_system', type: 'boolean', default: false })
  isSystem: boolean;

  /** 该角色绑定的权限（经 role_permissions 连接表） */
  @ManyToMany(() => Permission, (permission) => permission.roles)
  @JoinTable({
    name: 'role_permissions',
    joinColumn: { name: 'role_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permission_id', referencedColumnName: 'id' },
  })
  permissions: Permission[];

  /** 拥有该角色的用户（反向关系，连接表由 User 实体维护） */
  @ManyToMany(() => User, (user) => user.roles)
  users: User[];

  /** 创建时间（TypeORM 自动填充） */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** 更新时间（TypeORM 自动维护） */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  /** 软删除标记：NULL=未删除；软删后 find 默认过滤该行 */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
