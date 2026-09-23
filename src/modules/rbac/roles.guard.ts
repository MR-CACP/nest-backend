import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ADMIN_ROLE_CODE } from '../../common/constants/rbac.constants';
import {
  getRbacMetadata,
  PERMISSIONS_KEY,
  ROLES_KEY,
} from '../../common/decorators/rbac.decorator';
import { User } from '../auth/entities/user.entity';
import { type AuthenticatedRequest } from '../auth/jwt-auth.guard';

/**
 * RBAC 授权守卫：在 JwtAuthGuard 之后执行（@UseGuards(JwtAuthGuard, RolesGuard)），
 * 依赖它已完成认证并设置 request.user / request.userEntity。
 * 授权模型：
 * - 接口无 @Roles / @Permissions 元数据 → 放行（登录即可访问）；
 * - admin 角色硬编码旁路：拥有 admin 角色的用户直接放行，不查 role_permissions——
 *   新权限点上线 admin 自动拥有，不存在"给超管逐权限赋值"；
 * - 否则：加载用户角色（含角色权限），@Roles 或 @Permissions **任一命中**即放行（OR）；
 * - 未命中 → 403（已认证但无权限，区别于 401 未认证/登录失效）。
 * 即时性：角色/权限判定每请求查库（与 JwtAuthGuard 状态复查同原则）——
 * 管理端修改角色权限后，下一次请求即生效，无需踢用户下线。
 * 复用查询：JwtAuthGuard 已查过 user 实体并挂到 request.userEntity，这里直接复用
 * （userEntity 已含状态复查结果）；单独使用 RolesGuard（无前置 guard）时才自行查询。
 * DB 异常不吞：与 JwtAuthGuard 同一约定——数据库故障原样抛出转 500/503，
 * 不能伪装成 401/403 误导客户端。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const handler = context.getHandler();
    const classRef = context.getClass();

    // 类级+方法级合并读取（方法级优先）：裸 getMetadata 只读方法级，
    // 控制器类上的 @Roles/@Permissions 会静默失效
    const requiredRoles = getRbacMetadata<string[]>(
      ROLES_KEY,
      handler,
      classRef,
    );
    const requiredPermissions = getRbacMetadata<string[]>(
      PERMISSIONS_KEY,
      handler,
      classRef,
    );

    if (
      (!requiredRoles || requiredRoles.length === 0) &&
      (!requiredPermissions || requiredPermissions.length === 0)
    ) {
      return true; // 无权限声明：任何已登录用户可访问
    }

    // 复用 JwtAuthGuard 已查的 user 实体（含 roles 关系）；
    // 防御性兜底：未携带时自行加载（理论上不会发生）
    const user =
      request.userEntity ??
      (await this.users.findOne({
        where: { id: request.user.id },
        relations: {
          userRoles: { role: { rolePermissions: { permission: true } } },
        },
      }));
    if (!user) {
      // JwtAuthGuard 已保证用户存在且 active；此处兜底防御
      throw new ForbiddenException('没有访问权限');
    }

    const roleCodes = user.roles?.map((role) => role.code) ?? [];
    // 超管旁路：admin 角色直接放行（不依赖权限绑定）
    if (roleCodes.includes(ADMIN_ROLE_CODE)) {
      return true;
    }

    if (
      requiredRoles &&
      requiredRoles.some((code) => roleCodes.includes(code))
    ) {
      return true;
    }

    const permissionCodes = new Set<string>();
    for (const role of user.roles ?? []) {
      for (const permission of role.permissions ?? []) {
        permissionCodes.add(permission.code);
      }
    }
    if (
      requiredPermissions &&
      requiredPermissions.some((code) => permissionCodes.has(code))
    ) {
      return true;
    }

    throw new ForbiddenException('没有访问权限');
  }
}
