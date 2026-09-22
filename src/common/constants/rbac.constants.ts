/**
 * 超级管理员角色码：守卫硬编码旁路（见 roles.guard.ts），管理端不可改删。
 * 注意：必须与 InitRbac 迁移种子的角色 code 保持一致——迁移一旦应用不可变，
 * 此处若改动而旧库不重跑，旁路会静默失效。
 */
export const ADMIN_ROLE_CODE = 'admin';
/**
 * RBAC 管理端权限码（代码侧唯一真源）：
 * 接口用 @Permissions(PERMISSION_CODES.ROLE_CREATE) 声明，管理端按此码校验授权。
 * 注意：与迁移 InitRbacPermissions 的种子**一一对应**（迁移是自包含历史快照，
 * 不 import 本文件）——新增权限点 = ① 此处加常量 ② 迁移种子加一行（幂等）。
 */
export const PERMISSION_CODES = {
  /** 查看角色 / 权限列表 */
  ROLE_READ: 'role:read',
  /** 创建角色 */
  ROLE_CREATE: 'role:create',
  /** 更新角色（名称 / 描述，code 不可改） */
  ROLE_UPDATE: 'role:update',
  /** 删除角色（系统角色与已分配角色除外） */
  ROLE_DELETE: 'role:delete',
  /** 给角色分配权限（整体替换） */
  ROLE_ASSIGN_PERMISSION: 'role:assign-permission',
  /** 查看用户列表 */
  USER_READ: 'user:read',
  /** 给用户分配角色（整体替换） */
  USER_ASSIGN_ROLE: 'user:assign-role',
  /** 创建用户（管理员代建，密码必填） */
  USER_CREATE: 'user:create',
  /** 更新用户资料（昵称/性别/生日/头像等，不含登录标识与状态） */
  USER_UPDATE: 'user:update',
  /** 修改用户状态（active/disabled/banned；非 active 即撤销该用户全部会话） */
  USER_DISABLE: 'user:disable',
} as const;
