import { CustomDecorator, SetMetadata } from '@nestjs/common';

/** 元数据键：接口声明的角色码（@Roles）与权限码（@Permissions） */
export const ROLES_KEY = 'rbac:roles';
export const PERMISSIONS_KEY = 'rbac:permissions';

/**
 * 声明接口所需角色码（任一命中即放行，OR 语义）。
 * 用法：@Roles('admin') —— 只有 admin 可访问；
 *       @Roles('editor', 'admin') —— editor 或 admin 均可。
 * 与 @Permissions 同时存在时也是任一命中（角色或权限满足其一即可），
 * 这样 admin 角色无需为每个权限点重复配置（旁路已覆盖）。
 * 不挂任何装饰器 = 登录即可访问（RolesGuard 直接放行）。
 */
// CustomDecorator 同时兼容 ClassDecorator / MethodDecorator：
// @Roles/@Permissions 支持控制器类级声明（守卫按"方法级优先、类级兜底"合并读取）
export const Roles = (...codes: string[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, codes);

/**
 * 声明接口所需权限码（任一命中即放行，OR 语义）。
 * 权限点由代码声明：这里出现 'user:delete'，对应 permissions 表应存在
 * code='user:delete' 的行（随接口落地同步插入种子/迁移）。
 * 用法：@Permissions('user:delete') / @Permissions('user:read', 'user:update')
 */
export const Permissions = (...codes: string[]): CustomDecorator<string> =>
  SetMetadata(PERMISSIONS_KEY, codes);

/**
 * 读取角色/权限元数据（方法级优先、类级兜底——Nest Reflector.getAllAndOverride 语义）。
 * 裸 Reflect.getMetadata(KEY, handler) 只读方法级：若日后在控制器类上声明
 * @Roles/@Permissions 会静默失效；此 helper 显式合并类级声明。
 * @param handler 路由方法（context.getHandler()）——方法级元数据挂在这里
 * @param classRef 控制器类（context.getClass()）——类级元数据挂在类构造函数上；
 *                 注意不能用 handler.constructor（它是全局 Function，读不到类级声明）
 */
export function getRbacMetadata<T>(
  key: string,
  handler: object,
  classRef?: object,
): T | undefined {
  const fromHandler = Reflect.getMetadata(key, handler) as T | undefined;
  // 方法级已声明（含空数组）即以它为准；未声明才回退类级
  return (
    fromHandler ??
    (classRef
      ? (Reflect.getMetadata(key, classRef) as T | undefined)
      : undefined)
  );
}
