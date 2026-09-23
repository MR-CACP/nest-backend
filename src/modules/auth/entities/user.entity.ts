import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Role } from '../../rbac/entities/role.entity';
import { UserRole } from '../../rbac/entities/user-role.entity';

/**
 * 用户实体（users 表）：平台自有身份的主数据。
 * 设计要点：
 * - 邮箱/手机号均可空（登录方式多样，两者至少其一即可），PG 唯一索引允许多个 NULL；
 * - 唯一性用局部唯一索引（WHERE deleted_at IS NULL）：软删行不占用标识——
 *   注销账号的用户名/邮箱/手机号可被重新注册；普通 UNIQUE 约束会连同软删行一起
 *   判重，导致"应用层放行、DB 报 23505"的自相矛盾（见 auth.service 的 ensureAccountAvailable）。
 *   ⚠ 前向约束：局部索引意味着同一 username/email/phone 可能同时存在"已删行 + 活跃行"，
 *   ① 按标识的**读写**都必须显式带 deleted_at IS NULL（读：管理/客服按标识查用户会命中历史行；
 *   写：按标识 update/delete/softDelete 会连历史行一起命中，把已删行的 deleted_at 重新刷成
 *   新时间戳，静默破坏审计价值）；
 *   ② users 表的写操作一律以主键 id 定位，标识（username/email/phone）只用于登录等读路径
 *   （refresh_tokens 按 token_hash 写不受此限：该列普通 UNIQUE 且无软删，天然唯一）；
 * - 密码哈希用 bcrypt（盐内嵌于哈希，无独立盐值列）；
 * - 第三方登录与登录事件不在本表：分别由 user_oauth_accounts（后续阶段）与
 *   login_logs（认证接口阶段）承载，避免一张表背负所有身份形态；
 * - RBAC 阶段再以 roles 表关联（users 表不预置权限字段）。
 * - 所有列显式声明 type：可空联合类型（string | null）无法被反射推断，
 *   否则 TypeORM 报 DataTypeNotSupportedError。
 */
@Entity('users')
@Check(`status IN ('active', 'disabled', 'banned')`)
@Check(`gender IS NULL OR gender IN ('male', 'female', 'other')`)
// 管理端用户列表按 (created_at DESC, id DESC) 分页（见 users.service）——
// 复合索引覆盖排序路径，避免大表文件排序；实体声明 + 迁移同步（防 schema:log 漂移）
@Index('idx_users_created_id', ['createdAt', 'id'])
export class User {
  /** 主键：bigserial。注意 bigint 由 pg 驱动返回 string（避免 JS 精度丢失） */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** 登录用户名（软删行不占用：局部唯一索引仅约束未删除行） */
  @Index('UQ_users_username_active', ['username'], {
    unique: true,
    where: '"deleted_at" IS NULL',
  })
  @Column({ type: 'varchar', length: 50 })
  username: string;

  /** 邮箱（登录标识之一，可为空；软删行不占用，同上） */
  @Index('UQ_users_email_active', ['email'], {
    unique: true,
    where: '"deleted_at" IS NULL',
  })
  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  /** 手机号（登录标识之一，长度兼容国际号段；软删行不占用，同上） */
  @Index('UQ_users_phone_active', ['phone'], {
    unique: true,
    where: '"deleted_at" IS NULL',
  })
  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  /** bcrypt 密码哈希；第三方登录/未设密用户为 NULL */
  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  passwordHash: string | null;

  /** 昵称 */
  @Column({ type: 'varchar', length: 50, nullable: true })
  nickname: string | null;

  /** 真实姓名（实名场景用） */
  @Column({ name: 'real_name', type: 'varchar', length: 50, nullable: true })
  realName: string | null;

  /** 性别：male | female | other（数据库层由 CHECK 约束保证） */
  @Column({ type: 'varchar', length: 10, nullable: true })
  gender: 'male' | 'female' | 'other' | null;

  /** 出生日期 */
  @Column({ name: 'birth_date', type: 'date', nullable: true })
  birthDate: string | null;

  /** 头像 URL */
  @Column({ name: 'avatar_url', type: 'varchar', length: 500, nullable: true })
  avatarUrl: string | null;

  /** 邮箱认证时间；NULL=未认证 */
  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt: Date | null;

  /** 手机号认证时间；NULL=未认证 */
  @Column({ name: 'phone_verified_at', type: 'timestamptz', nullable: true })
  phoneVerifiedAt: Date | null;

  /** 账户状态：active | disabled | banned（禁用≠删除，保留数据） */
  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: 'active' | 'disabled' | 'banned';

  /**
   * 会话版本号（管理端"强制下线"预留字段）：签发 access token 时写入 JWT payload，
   * JwtAuthGuard 每请求比对 payload 版本与用户当前版本，不一致即 401——
   * 管理员踢人 = 版本 +1，该用户所有已签发 access token 立即失效（无状态 JWT
   * 无法主动撤销，靠版本比对实现"登出/封禁即时生效"）。
   * 当前仅预留：踢人逻辑在管理端（RBAC）阶段实现，此字段不对外暴露（不在 SafeUser 中）。
   */
  @Column({ name: 'session_version', type: 'int', default: 0 })
  sessionVersion: number;

  /**
   * 用户角色分配（user_roles 连接表行）：管理端增删分配直接 CRUD 此实体。
   * 为何不是 @ManyToMany/@JoinTable：显式连接表实体是 user_roles 的唯一元数据源
   * （双声明会让 TypeORM 生成两组 FK，schema:log 永久漂移）；@OneToMany 反向
   * 引用连接表实体的 @ManyToOne，关系加载与写入都走同一份定义。
   */
  @OneToMany(() => UserRole, (ur) => ur.user)
  userRoles: UserRole[];

  /**
   * 角色集合（userRoles.role 展开）：RBAC 判定与 /me 使用。
   * getter 让调用方保持 user.roles 形状；**加载关系时必须带 userRoles.role**
   * （如 relations: { userRoles: { role: true } }），否则返回 []。
   * 注意：getter 不参与序列化——对外响应仍走显式投影（toSafeUser/toAdminUser）。
   */
  get roles(): Role[] {
    // 连接表行的关联可空（ur.role?: Role），过滤后断言非空
    return (this.userRoles ?? [])
      .map((ur) => ur.role)
      .filter((r): r is Role => r != null);
  }

  /** 创建时间（TypeORM 自动填充） */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** 更新时间（TypeORM 自动维护） */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  /** 备注（运营/审核场景扩展字段） */
  @Column({ type: 'varchar', length: 500, nullable: true })
  remark: string | null;

  /** 软删除标记：NULL=未删除；软删后 find 默认过滤该行 */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}
