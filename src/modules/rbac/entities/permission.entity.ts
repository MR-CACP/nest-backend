import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Role } from './role.entity';

/**
 * 权限点实体（permissions 表）：RBAC 的最小授权单元。
 * 设计要点：
 * - 权限点由代码声明（接口挂 @Permissions('user:delete') 即存在该点），
 *   本表只做登记与展示；**只增不删**——删除权限点 = 代码移除该装饰器 +
 *   role_permissions 不再引用（管理端接口只读，不提供增删改）；
 * - code 约定 <资源>:<动作>（如 user:read / user:delete / role:manage）；
 * - 不做软删：权限点是代码的镜像，没有"停用"状态，不存在即废弃；
 * - 与角色的关联经 role_permissions 连接表（JoinTable 侧由 Role 实体维护）。
 */
@Entity('permissions')
@Index('UQ_permissions_code', ['code'], { unique: true })
export class Permission {
  /** 主键：bigserial */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** 权限码（如 user:read）；全局唯一，代码装饰器与 DB 行一一对应 */
  @Column({ type: 'varchar', length: 100 })
  code: string;

  /** 权限展示名（管理端权限树用） */
  @Column({ type: 'varchar', length: 50 })
  name: string;

  /** 权限分组（管理端权限树按组展示，如 用户管理 / 角色管理） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  group: string | null;

  /** 权限说明 */
  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  /** 创建时间（TypeORM 自动填充） */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** 拥有该权限的角色（反向关系，连接表由 Role 实体维护） */
  @ManyToMany(() => Role, (role) => role.permissions)
  roles: Role[];
}
