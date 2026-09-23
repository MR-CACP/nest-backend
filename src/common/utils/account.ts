import { BadRequestException } from '@nestjs/common';
import { hash } from 'bcrypt';

/**
 * 账号相关公共工具：注册（AuthModule）与管理端创建用户（UsersModule）共用。
 * 为什么抽公共：管理端创建的用户必须能登录——标识规范化（邮箱小写、
 * 手机去分隔符）与密码哈希规则必须与注册侧**完全一致**，两处各自实现
 * 必然漂移（如只改一处规则，管理端建的用户就登不上）。
 */

/** bcrypt 成本：注册/管理端创建统一用 10（约 50-100ms，抗 GPU 爆破） */
export const BCRYPT_COST = 10;

/**
 * 列宽裁剪（审计/日志落库前统一使用）："列宽由写入方保证"的唯一实现。
 * null/undefined → null（不落占位空串）；超长截断到 max。
 * auth 登录日志与 audit 管理审计共用，避免同一切割逻辑两种写法漂移。
 */
export function truncate(
  value: string | null | undefined,
  max: number,
): string | null {
  return value ? value.slice(0, max) : null;
}

/**
 * 账号脱敏（日志/审计用，不落 PII 明文）：
 * - 邮箱：首字符 + *** + @domain（al***@example.com）；
 * - 手机号：先规范化（去分隔符）再脱敏，避免原始串带 +86/空格/连字符时
 *   正则匹配失败、把明文写进日志；规范化后按 `+?数字` 识别；
 * - 其余形态（用户名等）：原样返回（用户名本身不是敏感 PII，且保留可追踪）。
 */
export function maskAccount(account: string): string {
  // 用 indexOf 而非 split：多 @ 输入（如 a@b@c）split 会丢尾部，审计不可丢数据；
  // indexOf 取首个 @ 后整体保留 @ 及之后部分（登录账号已过校验，多 @ 属异常输入）
  const at = account.indexOf('@');
  if (at > 0) {
    return `${account.charAt(0)}***${account.slice(at)}`;
  }
  const normalized = normalizePhone(account);
  if (normalized && /^\+?\d{6,20}$/.test(normalized)) {
    return normalized.length > 7
      ? `${normalized.slice(0, 3)}****${normalized.slice(-4)}`
      : '***';
  }
  return account;
}

/** 邮箱规范化：小写（PG varchar 大小写敏感，避免同邮箱双账号） */
export function normalizeEmail(email: string | undefined): string | null {
  return email ? email.trim().toLowerCase() : null;
}

/** 手机号规范化：去空格/连字符（保留可选 + 区号前缀） */
export function normalizePhone(phone: string | undefined): string | null {
  return phone ? phone.replace(/[\s-]/g, '') : null;
}

/**
 * 是否为 PostgreSQL 唯一约束冲突（SQLSTATE 23505）。
 * 用鸭子类型而非 instanceof 判断：TypeORM 抛出的 QueryFailedError 一定带
 * driverError.code === '23505'；不依赖具体类实例，跨模块 registry / 测试
 * mock（普通对象 { driverError: { code } }）同样命中，行为一致。
 */
export function isUniqueViolation(err: unknown): boolean {
  const driverError = (err as { driverError?: { code?: string } } | null)
    ?.driverError;
  return driverError?.code === '23505';
}

/**
 * bcrypt 只处理前 72 字节：超长（如 72 个汉字=216 字节）会被静默截断，直接拒绝。
 * 注册与管理端创建用户共用同一上限。
 */
export function assertPasswordByteLength(password: string): void {
  if (Buffer.byteLength(password, 'utf8') > 72) {
    throw new BadRequestException('密码过长（不能超过 72 字节）');
  }
}

/** bcrypt 哈希（统一成本，见 BCRYPT_COST） */
export function hashPassword(password: string): Promise<string> {
  return hash(password, BCRYPT_COST);
}
