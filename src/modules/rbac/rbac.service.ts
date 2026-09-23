import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import { AUDIT_ACTIONS } from '../../common/constants/audit.constants';
import { ADMIN_ROLE_CODE } from '../../common/constants/rbac.constants';
import { isUniqueViolation } from '../../common/utils/account';
import { AuditService } from '../audit/audit.service';
import { User } from '../auth/entities/user.entity';
import { CreateRoleDto, UpdateRoleDto } from './dto/rbac.dto';
import { Permission } from './entities/permission.entity';
import { Role } from './entities/role.entity';
import { RolePermission } from './entities/role-permission.entity';
import { UserRole } from './entities/user-role.entity';

/** 角色列表返回项（权限展开为权限码数组，前端直接消费） */
export interface RoleListItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  /** 绑定的权限码（admin 旁路不等于此列表——旁路拥有全部） */
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * RBAC 管理端服务：角色/权限的管理逻辑（用户列表与角色分配见 UsersModule）。
 * 设计要点：
 * - **REST 语义**：管理端接口遵循 HTTP 状态码（404/403/409），
 *   与认证端的"HTTP 200 + 业务码"（国内业务码惯例）刻意区分——
 *   管理端是内部工具，客户端需要精确的状态语义；
 * - **系统角色保护**：is_system=true（admin/user 种子）完全只读——
 *   改 code 会破坏 @Roles('admin') 等代码引用，改权限绑定会与守卫旁路语义冲突；
 * - **角色 code 不可改**：code 是代码引用（@Roles('editor')）与 user_roles 的
 *   业务键，PATCH 只允许 name/description（UpdateRoleDto 无 code 字段）；
 * - **整体替换语义**：分配权限/角色 = 先删后插（同一事务），
 *   空数组 = 清空（合法），避免"增量增删"的状态漂移；
 * - **提权防护（管理权限不能自我提升）**：授权操作（分配权限/角色）的目标
 *   必须是操作者**自己已有集**的子集——admin 旁路例外。否则持有
 *   role:assign-permission 的用户可给自己所在角色绑任意权限点、
 *   user:assign-role 的用户可把自己提升为 admin，等于一路升级到超管；
 * - 删除角色前必须解除 user_roles 引用（409），防误删导致用户权限悬空。
 */
@Injectable()
export class RbacService {
  constructor(
    @InjectRepository(Role) private readonly roles: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    @InjectRepository(RolePermission)
    private readonly rolePermissions: Repository<RolePermission>,
    // 提权防护用：查操作者的角色/权限集合（RolesGuard 也注入 User，本模块已注册）
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /** 角色列表（含权限码；软删行过滤） */
  async listRoles(): Promise<RoleListItem[]> {
    const roles = await this.roles.find({
      relations: { rolePermissions: { permission: true } },
      order: { createdAt: 'ASC' },
    });
    return roles.map((role) => ({
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissions: role.permissions.map((p) => p.code),
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
    }));
  }

  /** 创建角色：code 唯一（预检 + 23505 兜底并发），isSystem 恒为 false */
  async createRole(
    dto: CreateRoleDto,
    operatorId: string,
    /** 操作者 IP（controller 透传 req.ip，落 audit_logs） */
    ip?: string,
  ): Promise<Role> {
    const exists = await this.roles.findOne({ where: { code: dto.code } });
    if (exists) {
      throw new ConflictException('角色 code 已存在');
    }
    try {
      const saved = await this.roles.save({
        code: dto.code,
        name: dto.name,
        description: dto.description ?? null,
      });
      // 操作审计（尽力而为）
      await this.audit.record({
        operatorId,
        action: AUDIT_ACTIONS.ROLE_CREATE,
        resourceType: 'role',
        resourceId: saved.id,
        detail: { code: saved.code, name: saved.name },
        ip,
      });
      return saved;
    } catch (err: unknown) {
      // 并发创建同名角色：唯一索引冲突兜底（统一走 isUniqueViolation，与 auth/users 同口径）
      if (isUniqueViolation(err)) {
        throw new ConflictException('角色 code 已存在');
      }
      throw err;
    }
  }

  /** 更新角色：只允许 name/description（code 不可改，DTO 无该字段）；系统角色 403 */
  async updateRole(
    id: string,
    dto: UpdateRoleDto,
    operatorId: string,
    /** 操作者 IP（controller 透传 req.ip，落 audit_logs） */
    ip?: string,
  ): Promise<Role> {
    const role = await this.roles.findOneBy({ id });
    if (!role) {
      throw new NotFoundException('角色不存在');
    }
    if (role.isSystem) {
      throw new ForbiddenException('系统内置角色不允许修改');
    }
    role.name = dto.name;
    // PATCH 部分更新语义：description 未传（undefined）不覆盖已有值——
    // 与 updateUser/updateMe 的"undefined 不落库"模式一致，避免只改 name 时
    // 把既有描述静默清空；传空串可显式清空（DTO 层 null 会被 @IsString 拒绝）
    if (dto.description !== undefined) {
      role.description = dto.description;
    }
    const saved = await this.roles.save(role);
    // 操作审计（尽力而为）
    await this.audit.record({
      operatorId,
      action: AUDIT_ACTIONS.ROLE_UPDATE,
      resourceType: 'role',
      resourceId: id,
      detail: {
        code: role.code,
        name: role.name,
        description: role.description,
      },
      ip,
    });
    return saved;
  }

  /** 删除角色（软删）：系统角色 403；仍有关联用户 409（先解绑再删） */
  async deleteRole(
    id: string,
    operatorId: string,
    /** 操作者 IP（controller 透传 req.ip，落 audit_logs） */
    ip?: string,
  ): Promise<void> {
    const role = await this.roles.findOneBy({ id });
    if (!role) {
      throw new NotFoundException('角色不存在');
    }
    if (role.isSystem) {
      throw new ForbiddenException('系统内置角色不允许删除');
    }
    // UserRole 不在本模块 forFeature 注册（属用户域，UsersModule），
    // 通过 DataSource 直接取仓库（DataSource 全局可用，无需模块注册）
    const assigned = await this.dataSource
      .getRepository(UserRole)
      .count({ where: { roleId: id } });
    if (assigned > 0) {
      throw new ConflictException('该角色已分配给用户，请先解除分配');
    }
    // 软删：局部唯一索引（WHERE deleted_at IS NULL）释放 code，可重建。
    // 同一事务内清掉 role_permissions 绑定行——软删的角色不再承载权限，
    // 残留绑定只会污染后续"该角色是否被引用"的判断（审计需要原始权限快照时应另建历史表）
    await this.dataSource.transaction(async (manager) => {
      // 必须用 manager 的仓库：默认仓库不受事务保护（与 assignRolePermissions 同一陷阱）
      await manager.getRepository(RolePermission).delete({ roleId: id });
      await manager.getRepository(Role).softDelete({ id });
    });
    // 操作审计（尽力而为）
    await this.audit.record({
      operatorId,
      action: AUDIT_ACTIONS.ROLE_DELETE,
      resourceType: 'role',
      resourceId: id,
      detail: { code: role.code },
      ip,
    });
  }

  /**
   * 给角色分配权限（整体替换）：系统角色 403；权限码存在性校验；
   * **提权防护**：目标权限必须是操作者自己已有权限的子集（admin 旁路例外）——
   * 否则持有 role:assign-permission 的人可给自己所在角色绑上它没有的权限点，
   * 一路升级到超管；
   * "撤销 + 落库"同一事务——中途失败整体回滚，不出现半替换状态。
   * @param roleId 目标角色 ID
   * @param permissionIds 目标权限点 ID 列表（空数组 = 清空）
   * @param operatorId 当前操作者用户 ID（access 令牌载荷）
   */
  async assignRolePermissions(
    roleId: string,
    permissionIds: string[],
    operatorId: string,
    /** 操作者 IP（controller 透传 req.ip，落 audit_logs） */
    ip?: string,
  ): Promise<void> {
    const role = await this.roles.findOneBy({ id: roleId });
    if (!role) {
      throw new NotFoundException('角色不存在');
    }
    if (role.isSystem) {
      throw new ForbiddenException('系统内置角色不允许修改权限');
    }
    const ids = [...new Set(permissionIds)];
    if (ids.length > 0) {
      const found = await this.permissions.find({ where: { id: In(ids) } });
      if (found.length !== ids.length) {
        throw new BadRequestException('存在无效的权限点');
      }
      await this.assertPermissionsGrantable(ids, operatorId);
    }
    await this.dataSource.transaction(async (manager) => {
      // 必须用 manager 的仓库：TypeORM 中默认仓库绑定默认连接、不受事务保护，
      // 会独立连接立即提交（本模块与 auth.refresh 同一陷阱，见 auth.service.ts 注释）
      const rpRepo = manager.getRepository(RolePermission);
      await rpRepo.delete({ roleId });
      if (ids.length > 0) {
        await rpRepo.insert(
          ids.map((permissionId) => ({ roleId, permissionId })),
        );
      }
    });
    // 操作审计（尽力而为）
    await this.audit.record({
      operatorId,
      action: AUDIT_ACTIONS.ROLE_PERMISSIONS_ASSIGN,
      resourceType: 'role',
      resourceId: roleId,
      detail: { permissionIds: ids },
      ip,
    });
  }

  /**
   * 提权防护：目标权限必须是操作者已有权限的子集（admin 旁路例外）。
   * 操作者权限即时查库（与"每请求查库"模型一致），不依赖令牌内快照。
   * 取舍说明：管理端写路径的 3 个防护方法各自 findOne 操作者（含 roles），
   * 而 req.userEntity 已携带同信息——刻意不复用，原因是 service 不信任调用方
   * 传入的角色快照（未来若出现非 guard 调用路径也不会绕过提权防护），
   * 且低频管理操作多 1 次主键查询可忽略（"每请求查库"模型的自然代价）。
   */
  private async assertPermissionsGrantable(
    targetPermissionIds: string[],
    operatorId: string,
  ): Promise<void> {
    const operator = await this.users.findOne({
      where: { id: operatorId },
      relations: {
        userRoles: { role: { rolePermissions: { permission: true } } },
      },
    });
    // JwtAuthGuard 已保证操作者存在且 active；此处防御性兜底
    if (!operator) {
      throw new ForbiddenException('没有访问权限');
    }
    if (operator.roles?.some((role) => role.code === ADMIN_ROLE_CODE)) {
      return; // admin 旁路：拥有全部权限，可授予任意权限点
    }
    const ownedIds = new Set(
      operator.roles
        ?.flatMap((role) => role.permissions ?? [])
        .map((permission) => permission.id),
    );
    if (!targetPermissionIds.every((id) => ownedIds.has(id))) {
      throw new ForbiddenException(
        '只能分配自己拥有的权限（防止权限自我提升）',
      );
    }
  }

  /** 权限点列表（只读）：按分组 + 码排序，管理端权限树数据源 */
  listPermissions(): Promise<Permission[]> {
    return this.permissions.find({ order: { group: 'ASC', code: 'ASC' } });
  }
}
