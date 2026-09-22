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
