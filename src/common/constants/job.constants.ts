/**
 * 定时任务动作码唯一真源（镜像 PERMISSION_CODES / AUDIT_ACTIONS 的约定）。
 * 动作码是"任务定义 → 服务方法"的桥梁：job_definitions.action_code 只能取这里的 key，
 * 新增可调度任务时在此登记 + 在 JobService.actionRunners 挂执行函数。
 */
export const JOB_ACTIONS = {
  'cleanup:refresh-tokens': {
    description: '清理过期超过保留期的 refresh token',
  },
  'cleanup:audit-logs': {
    description: '清理超保留期的审计日志（login_logs / audit_logs）',
  },
  'cleanup:job-runs': {
    description: '清理超保留期的任务执行日志（job_runs）',
  },
} as const;

export type JobActionCode = keyof typeof JOB_ACTIONS;
