import { ForbiddenException } from '@nestjs/common';

import { ADMIN_ROLE_CODE } from '../constants/rbac.constants';

/** 角色形状（只取 code 判定 admin） */
export interface RoleCodeShape {
  code: string;
}

/** 操作者形状（含可选 roles——未加载时按无角色处理） */
export interface OperatorShape {
  roles?: RoleCodeShape[];
}

/**
 * 降级防护（管理端写路径共用）：非 admin 操作者不得变更/影响持有 admin 角色的账号。
 * 语义与 users.assignUserRoles / updateUserStatus 完全一致（同一真源）：
 * - admin 旁路：拥有 admin 角色即拥有全部管理权限，可操作任意账号；
 * - 非 admin 操作者若对 admin 账号执行管理操作（改角色/状态/下线会话），拒绝 403——
 *   防止"内部人反复踢 admin / 锁死超管"的骚扰级 DoS（下线后重登即恢复，但可无限循环）。
 * @param targetRoles 目标账号角色（判定目标是否持 admin）
 * @param operator 操作者（查库后的对象；null = 操作者不存在）
 * @param message 场景化 403 文案（默认覆盖"角色/状态"场景）
 */
export function assertNoAdminDowngrade(
  targetRoles: RoleCodeShape[] | undefined,
  operator: OperatorShape | null,
  message = '无权变更管理员账号的角色或状态',
): void {
  if (!operator) {
    throw new ForbiddenException('没有访问权限');
  }
  if (operator.roles?.some((role) => role.code === ADMIN_ROLE_CODE)) {
    return; // admin 旁路：可管理任意账号
  }
  if (targetRoles?.some((role) => role.code === ADMIN_ROLE_CODE)) {
    throw new ForbiddenException(message);
  }
}
