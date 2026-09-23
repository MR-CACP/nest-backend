import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { RolePermission } from './role-permission.entity';

/**
 * 权限点实体（permissions 表）：RBAC 的最小授权单元。
 * 设计要点：
 * - 权限点由代码声明（接口挂 @Permissions('user:delete') 即存在该点），
 *   本表只做登记与展示；**只增不删**——删除权限点 = 代码移除该装饰器 +
 *   role_permissions 不再引用（管理端接口只读，不提供增删改）；
 * - code 约定 <资源>:<动作>（如 user:read / user:delete / role:manage）；
 * - 不做软删：权限点是代码的镜像，没有"停用"状态，不存在即废弃；
 * - 与角色的关联经 role_permissions 连接表实体（RolePermission）单向声明：
 *   本实体只用 @OneToMany 反向引用，不参与连接表列/约束定义（避免同表双元数据源）。
 */
@Entity('permissions')
export class Permission {
  /** 主键：bigserial */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /**
   * 权限码（如 user:read）；全局唯一，代码装饰器与 DB 行一一对应。
   * unique: true 生成 UNIQUE 约束 UQ_permissions_code（与 InitRbac 迁移一致；
   * @Index({ unique: true }) 会生成唯一索引而非约束，schema:log 视为两种定义）
   */
  @Column({ type: 'varchar', length: 100, unique: true })
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

  /** 持有该权限的角色绑定（role_permissions 连接表行；反向关系） */
  @OneToMany(() => RolePermission, (rp) => rp.permission)
  rolePermissions: RolePermission[];
}
