/**
 * 审计动作码（代码侧唯一真源）：
 * 写入埋点统一引用 AUDIT_ACTIONS，避免 10 个点分字符串散落在三个模块——
 * 与权限码 PERMISSION_CODES 同口径（"代码声明、迁移只登记权限点"，
 * 审计动作码不单独建表，随 audit_logs.action varchar(100) 落库）。
 * 命名约定：<域>.<动词>（user.create / role.update / session.revoke_all），
 * 查询接口按动作码**等值**过滤（非前缀/模糊）。
 */
export const AUDIT_ACTIONS = {
  /** 创建用户（管理员代建） */
  USER_CREATE: 'user.create',
  /** 更新用户资料（只记变更字段名） */
  USER_UPDATE: 'user.update',
  /** 修改用户状态（active/disabled/banned） */
  USER_STATUS_UPDATE: 'user.status.update',
  /** 给用户分配角色（整体替换） */
  USER_ROLES_ASSIGN: 'user.roles.assign',
  /** 创建角色 */
  ROLE_CREATE: 'role.create',
  /** 更新角色（名称/描述） */
  ROLE_UPDATE: 'role.update',
  /** 删除角色 */
  ROLE_DELETE: 'role.delete',
  /** 给角色分配权限（整体替换） */
  ROLE_PERMISSIONS_ASSIGN: 'role.permissions.assign',
  /** 强制下线单个会话 */
  SESSION_REVOKE: 'session.revoke',
  /** 强制下线某用户全部会话 */
  SESSION_REVOKE_ALL: 'session.revoke_all',
} as const;
