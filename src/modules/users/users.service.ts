import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import { ADMIN_ROLE_CODE } from '../../common/constants/rbac.constants';
import {
  assertPasswordByteLength,
  hashPassword,
  isUniqueViolation,
  normalizeEmail,
  normalizePhone,
} from '../../common/utils/account';
import { assertNoAdminDowngrade } from '../../common/utils/admin-guard';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { User } from '../auth/entities/user.entity';
import { Role } from '../rbac/entities/role.entity';
import { UserRole } from '../rbac/entities/user-role.entity';
import {
  CreateUserDto,
  ListUsersQuery,
  UpdateUserDto,
  UpdateUserStatusDto,
} from './users.dto';

/** 用户列表返回项（基础信息 + 角色码） */
export interface UserListItem {
  id: string;
  username: string;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  status: string;
  /** 角色码（不含权限——角色权限见 /roles） */
  roles: string[];
  createdAt: Date;
}

/**
 * 管理端用户单项投影：显式挑选对外字段，
 * **杜绝 passwordHash / sessionVersion / deletedAt 等内部列外泄**
 * （与 auth 侧 SafeUser 同原则；管理端额外含 realName/remark）。
 */
export interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  phone: string | null;
  nickname: string | null;
  realName: string | null;
  gender: string | null;
  birthDate: string | null;
  avatarUrl: string | null;
  status: string;
  remark: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 用户管理服务：用户分页列表、角色分配、创建用户、改资料、改状态
 * （用户资源上的管理操作）。
 * 与 RBAC 模块的分工：/api/users 归用户管理域（未来 CRUD/状态管理加在这里），
 * rbac 只管 /roles、/permissions 与角色-权限绑定。
 * 设计要点：
 * - **REST 语义**：管理端遵循 HTTP 状态码（404/400），与认证端"HTTP 200 + 业务码"区分；
 * - **整体替换语义**：分配角色 = 先删后插（同一事务），空数组 = 清空（合法），
 *   避免"增量增删"的状态漂移；
 * - **按标识读、按主键写**：users 表标识列（username/email/phone）可因局部唯一索引
 *   存在"已删行 + 活跃行"并存，列表/分配一律按 id 定位。
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    @InjectRepository(UserRole)
    private readonly userRoles: Repository<UserRole>,
    private readonly dataSource: DataSource,
  ) {}

  /** 用户分页列表（含角色码；软删默认过滤） */
  async listUsers(query: ListUsersQuery): Promise<{
    items: UserListItem[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 10));
    const [items, total] = await this.users.findAndCount({
      relations: { roles: true },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: items.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        phone: u.phone,
        nickname: u.nickname,
        status: u.status,
        roles: u.roles.map((r) => r.code),
        createdAt: u.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 给用户分配角色（整体替换）：用户/角色存在性校验；
   * 事务保证不出现"旧角色已清、新角色未落"的中间态。
   * **提权防护**：
   * - 授予的角色必须是操作者自己拥有的角色的子集（admin 旁路例外），
   *   否则持有 user:assign-role 的人可把 admin 角色分配给自己/他人，
   *   一路升级到超管——"管理权限不能自我提升"；
   * - **降级防护**：非 admin 操作者不得变更"拥有 admin 角色"的目标账号
   *   （整体替换传 [] 可剥离管理员的角色，锁死超管），同样 403。
   * @param userId 目标用户 ID
   * @param roleIds 目标角色 ID 列表（空数组 = 清空）
   * @param operatorId 当前操作者用户 ID（access 令牌载荷）
   */
  async assignUserRoles(
    userId: string,
    roleIds: string[],
    operatorId: string,
  ): Promise<void> {
    // 目标含 roles：降级防护需要判断目标是否持有 admin 角色
    const user = await this.users.findOne({
      where: { id: userId },
      relations: { roles: true },
    });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    const ids = [...new Set(roleIds)];
    if (ids.length > 0) {
      const found = await this.roles.find({ where: { id: In(ids) } });
      if (found.length !== ids.length) {
        throw new BadRequestException('存在无效的角色');
      }
    }
    // 操作者只查一次，供降级/提权/最后 admin 三个校验共用（低频管理路径去重）
    const operator = await this.users.findOne({
      where: { id: operatorId },
      relations: { roles: true },
    });
    if (!operator) {
      throw new ForbiddenException('没有访问权限');
    }
    assertNoAdminDowngrade(user.roles, operator);
    if (ids.length > 0) {
      this.assertRolesGrantable(ids, operator);
    }
    // 最后 admin 保护：目标原本持 admin 且新角色集不含 admin → 失去 admin 资格
    const adminRole = await this.roles.findOneBy({ code: ADMIN_ROLE_CODE });
    const keepsAdmin = adminRole ? ids.includes(adminRole.id) : false;
    await this.dataSource.transaction(async (manager) => {
      // 并发安全（最后 admin 判定与变更同事务）：先 SELECT ... FOR UPDATE 锁 admin 角色行——
      // 两个管理员并发互移/互禁时在此串行化，后到者 count 到变更后的真实数量；
      // 否则两个事务都读到 count=2 会同时放行，把系统锁死。
      // ponytail: single admin-role lock serializes rare admin writes; shard/advisory locks if throughput matters.
      // 必须用 manager 的仓库：TypeORM 默认仓库绑定默认连接、不受事务保护，
      // 会独立连接立即提交（与 rbac.assignRolePermissions 同一陷阱）
      const lockedAdminRole = await manager.getRepository(Role).findOne({
        where: { code: ADMIN_ROLE_CODE },
        lock: { mode: 'pessimistic_write' },
      });
      await this.assertNotLastAdmin(
        user.roles,
        operator,
        !keepsAdmin,
        lockedAdminRole,
        manager,
      );
      const urRepo = manager.getRepository(UserRole);
      await urRepo.delete({ userId });
      if (ids.length > 0) {
        await urRepo.insert(ids.map((roleId) => ({ userId, roleId })));
      }
    });
  }

  /**
   * 管理员代建用户：校验/规范化/哈希规则与注册完全一致（共用 common/utils/account），
   * 保证管理端创建的用户能正常登录；唯一性冲突（含并发）映射 409。
   * 不分配角色（调用方按需走 assignUserRoles），新用户 status 默认 active。
   */
  async createUser(dto: CreateUserDto): Promise<AdminUser> {
    assertPasswordByteLength(dto.password);
    await this.ensureAccountAvailable(dto);
    const passwordHash = await hashPassword(dto.password);
    try {
      const saved = await this.users.save(
        this.users.create({
          username: dto.username,
          email: normalizeEmail(dto.email),
          phone: normalizePhone(dto.phone),
          nickname: dto.nickname ?? null,
          passwordHash,
        }),
      );
      return this.toAdminUser(saved);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('用户名、邮箱或手机号已被占用');
      }
      throw err;
    }
  }

  /**
   * 更新用户资料（管理端）：只允许资料字段（DTO 已限定）。
   * 登录标识（username/email/phone）不可在此修改——标识变更依赖验证流程，
   * 且作为唯一键的改动会牵动登录/会话，后续阶段单独处理；
   * 状态修改走 updateUserStatus（独立权限点）。
   * 写操作一律以主键 id 定位（局部唯一索引下按标识写会连历史行一起命中）。
   */
  async updateUser(id: string, dto: UpdateUserDto): Promise<AdminUser> {
    const user = await this.users.findOneBy({ id });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    // 只落传入字段（undefined 不覆盖）：DTO 全可选，避免空请求把已有资料清空。
    // 注意不能用 Object.assign(user, { 全字段 })：未传字段会以 undefined 写进内存实体，
    // save() 跳过 undefined 列（库不受影响），但返回的是被改写的内存对象 → 投影读成
    // undefined（响应与持久化不一致）。所以逐字段守卫 + 保存后重查（与 auth.updateMe 同模式）。
    if (dto.nickname !== undefined) user.nickname = dto.nickname;
    if (dto.realName !== undefined) user.realName = dto.realName;
    if (dto.gender !== undefined) user.gender = dto.gender;
    if (dto.birthDate !== undefined) user.birthDate = dto.birthDate;
    if (dto.avatarUrl !== undefined) user.avatarUrl = dto.avatarUrl;
    if (dto.remark !== undefined) user.remark = dto.remark;
    await this.users.save(user);
    // 保存后重查：响应反映持久化状态（含未修改字段的真实值）
    const saved = await this.users.findOneBy({ id });
    // 刚 save 成功，用户必然存在（findOneBy 默认过滤软删；此处防御性兜底）
    if (!saved) {
      throw new NotFoundException('用户不存在');
    }
    return this.toAdminUser(saved);
  }

  /**
   * 修改用户状态（管理端）：active 恢复 / disabled 禁用 / banned 封禁。
   * 语义：
   * - 非 active：登录与刷新已被认证链路拒绝（auth.service 校验 status），
   *   这里**再撤销该用户全部活跃 refresh token**——"禁用"是终止会话而非暂停：
   *   恢复 active 后旧会话也不复存在，必须重新登录；
   * - 恢复 active：不清空历史（revoked 会话保留审计），下次登录自然建立新会话；
   * - 离开 active 递增 session_version → 旧 access **即时失效**（JwtAuthGuard 每请求
   *   比对版本，不等 15 分钟窗口）；恢复后旧令牌也不得复活（版本失配 401），必须重新登录。
   */
  async updateUserStatus(
    id: string,
    dto: UpdateUserStatusDto,
    operatorId: string,
  ): Promise<AdminUser> {
    // 目标含 roles：降级防护需要判断目标是否持有 admin 角色
    const user = await this.users.findOne({
      where: { id },
      relations: { roles: true },
    });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    // 降级防护：非 admin 操作者不得禁用/变更管理员账号（防止内部锁死超管）
    const operator = await this.users.findOne({
      where: { id: operatorId },
      relations: { roles: true },
    });
    if (!operator) {
      throw new ForbiddenException('没有访问权限');
    }
    assertNoAdminDowngrade(user.roles, operator);
    const saved = await this.dataSource.transaction(async (manager) => {
      // ① 先锁**目标用户行**（SELECT ... FOR UPDATE）：并发状态更新与"全部下线"都以
      //    锁用户行为前置，串行化后**锁内快照即最新**——否则两个并发 PATCH 都基于
      //    事务外读到的旧 status/sessionVersion 计算，后提交者会用旧版本覆盖先提交者
      //    的递增（版本回退 → 旧 access 复活），也会覆盖 revokeAllByUser 刚递增的
      //    版本。锁内重读 + 重算使"版本递增与状态保存同事务"跨请求成立。
      // ② 离开 active 必须递增 session_version：仅撤销 refresh 只让旧 access "暂时"
      //    失效——恢复为 active 后旧 JWT 的状态与版本号都重新通过校验，无需重登即可
      //    继续使用，违反"旧会话必须重新登录"契约。递增后旧 access **永久**失效
      //    （版本失配 401）；恢复无需再递增（旧令牌反正已失效，重新登录才拿到新版本）。
      // 必须用 manager 的仓库：TypeORM 默认仓库绑定默认连接、不受事务保护
      // （与 assignUserRoles / rbac.deleteRole 同一陷阱）
      // ⚠ 锁查询**不带 relations**：TypeORM 对 lock + relations 会生成两层查询
      // （distinctAlias 分页包装），FOR UPDATE 落在子查询内 → PG 语法错误 500；
      // 单层锁查询才合法（revokeAllByUser 同款）。
      const lockedUser = await manager.getRepository(User).findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedUser) {
        throw new NotFoundException('用户不存在');
      }
      // ② **先锁 admin 角色行**（FOR UPDATE，与 assignUserRoles 同款）：任何"授予/移除
      //    admin 角色"的事务（assignUserRoles 也先锁 admin 角色行）都在此处排队——
      //    ③ 的角色重读因此拿到稳定值，不再与角色提交赛跑。若重读在前、锁在后，
      //    授予可能发生在重读之后、状态校验之前，事务外/锁前快照都会漏判。
      // 锁顺序：状态变更 = 用户行 → admin 角色行；角色变更（assignUserRoles）=
      // admin 角色行 → user_roles 行。两者无循环等待（角色变更不锁用户行），不构成死锁；
      // 若未来引入更多"用户行 + 角色行"组合变更，需统一锁顺序（注释记录）
      const lockedAdminRole = await manager.getRepository(Role).findOne({
        where: { code: ADMIN_ROLE_CODE },
        lock: { mode: 'pessimistic_write' },
      });
      // ③ 锁后重读角色关系（无锁、读已提交最新）：admin 角色行已锁，此值在事务内稳定
      const rolesForCheck =
        (
          await manager.getRepository(User).findOne({
            where: { id },
            relations: { roles: true },
          })
        )?.roles ?? [];
      // ④ 事务内复核降级防护：非 admin 操作者 + 目标（锁后）已持 admin → 403。
      //    事务外快照可能滞后（目标恰在并发被授予 admin 角色），此复核用锁内最新
      //    角色兜底——否则非 admin 操作者可趁并发授予窗口禁用/影响刚成为 admin 的账号，
      //    降级防护被绕过（事务外 assertNoAdminDowngrade(user.roles, ...) 仅作快速失败）
      assertNoAdminDowngrade(rolesForCheck, operator);
      const leavingActive =
        lockedUser.status === 'active' && dto.status !== 'active';
      if (leavingActive) {
        lockedUser.sessionVersion += 1;
      }
      lockedUser.status = dto.status;
      // save 与 revoke 必须同生共死：先落状态后撤销失败会留下
      // revokedAt IS NULL 的活跃会话行（审计视图失真）。
      // ⑤ 最后 admin 校验（同一份锁内角色快照）：两个 admin 并发互禁时串行化，
      //    后到者 count 到真实数量
      await this.assertNotLastAdmin(
        rolesForCheck,
        operator,
        dto.status !== 'active',
        lockedAdminRole,
        manager,
      );
      // sessionVersion 递增与 save 同事务：离开 active 的版本变化原子落库
      const savedUser = await manager.getRepository(User).save(lockedUser);
      if (dto.status !== 'active') {
        // 撤销活跃会话：幂等（revokedAt IS NULL 条件），不重写已撤销时间
        await manager
          .getRepository(RefreshToken)
          .update(
            { userId: id, revokedAt: IsNull() },
            { revokedAt: new Date() },
          );
      }
      return savedUser;
    });
    return this.toAdminUser(saved);
  }

  /**
   * 最后一个 admin 保护：admin（旁路）也不能把系统锁死——
   * 若目标持 admin 角色、操作者是 admin、且本次变更会使系统不再有活跃 admin，
   * 拒绝（403）。非 admin 操作者走 assertNoAdminDowngrade 已拦截，到不了这里。
   * 必须在变更所在事务内调用（调用方已先锁 admin 角色行）：
   * "count + 变更"同事务才能防止两个 admin 并发互移/互禁都读到 count=2 的竞态。
   * @param willLoseAdmin 调用方已判定：本次变更会使目标失去 admin 资格
   * @param adminRole 调用方已锁定的 admin 角色行（SELECT ... FOR UPDATE，可能不存在）
   * @param manager 当前事务的 EntityManager（count 与变更同一快照）
   */
  private async assertNotLastAdmin(
    targetRoles: { code: string }[] | undefined,
    operator: { roles?: { code: string }[] } | null,
    willLoseAdmin: boolean,
    adminRole: { id: string } | null,
    manager: EntityManager,
  ): Promise<void> {
    if (
      !willLoseAdmin ||
      !operator?.roles?.some((role) => role.code === ADMIN_ROLE_CODE)
    ) {
      return;
    }
    if (!targetRoles?.some((role) => role.code === ADMIN_ROLE_CODE)) {
      return;
    }
    if (!adminRole) {
      return;
    }
    // 统计仍活跃且持 admin 角色的用户数（user_roles join users）
    const activeAdmins = await manager
      .getRepository(UserRole)
      .createQueryBuilder('ur')
      .innerJoin(
        User,
        'u',
        'u.id = ur.user_id AND u.status = :active AND u.deleted_at IS NULL',
        { active: 'active' },
      )
      .where('ur.role_id = :rid', { rid: adminRole.id })
      .getCount();
    if (activeAdmins <= 1) {
      throw new ForbiddenException('不能移除最后一个管理员');
    }
  }

  /** 管理端用户投影：显式挑选对外字段（passwordHash/sessionVersion/deletedAt 不外泄） */
  private toAdminUser(user: User): AdminUser {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      phone: user.phone,
      nickname: user.nickname,
      realName: user.realName,
      gender: user.gender,
      birthDate: user.birthDate,
      avatarUrl: user.avatarUrl,
      status: user.status,
      remark: user.remark,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * 提权防护：目标角色必须是操作者已有角色的子集（admin 旁路例外）。
   * @param operator 操作者实体（含 roles）——由调用方即时查库传入，不依赖令牌快照
   */
  private assertRolesGrantable(
    targetRoleIds: string[],
    operator: { roles?: { id: string; code: string }[] } | null,
  ): void {
    if (!operator) {
      throw new ForbiddenException('没有访问权限');
    }
    if (operator.roles?.some((role) => role.code === ADMIN_ROLE_CODE)) {
      return; // admin 旁路：拥有全部角色，可授予任意角色
    }
    const ownedRoleIds = new Set(operator.roles?.map((role) => role.id));
    if (!targetRoleIds.every((roleId) => ownedRoleIds.has(roleId))) {
      throw new ForbiddenException(
        '只能分配自己拥有的角色（防止权限自我提升）',
      );
    }
  }

  /** 账号可用性：与注册同规则（软删行可复用；并发冲突由 23505 兜底） */
  private async ensureAccountAvailable(dto: CreateUserDto): Promise<void> {
    const conflict = await this.users.findOne({
      withDeleted: true, // 包含软删行，否则唯一索引上的软删行会绕过应用层检查
      where: [
        { username: dto.username },
        ...(dto.email
          ? [{ email: normalizeEmail(dto.email) ?? undefined }]
          : []),
        ...(dto.phone
          ? [{ phone: normalizePhone(dto.phone) ?? undefined }]
          : []),
      ],
    });
    if (conflict && conflict.deletedAt === null) {
      // 不区分具体冲突字段：避免枚举已存在账号（与注册同口径）
      throw new ConflictException('用户名、邮箱或手机号已被占用');
    }
  }
}
