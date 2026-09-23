import {
  isUniqueViolation,
  maskAccount,
  truncate,
} from '@/common/utils/account';

/**
 * 公共账号工具单测。
 * 覆盖 maskAccount 全部分支（导出公共 util，此前仅被 auth 间接覆盖）：
 * 邮箱 / 手机号（长、短）/ 多 @ / 非邮箱非手机原样返回；truncate 列宽裁剪契约。
 */
describe('account utils', () => {
  describe('maskAccount', () => {
    it('邮箱：首字符 + *** + @domain', () => {
      expect(maskAccount('alice@example.com')).toBe('a***@example.com');
    });

    it('多 @ 输入：indexOf 取首 @，尾部完整保留不丢（a@b@c → a***@b@c）', () => {
      expect(maskAccount('a@b@c')).toBe('a***@b@c');
    });

    it('11 位手机号：前 3 + **** + 后 4', () => {
      expect(maskAccount('13800138000')).toBe('138****8000');
    });

    it('手机号带 +86/分隔符：先规范化再脱敏（不落明文）', () => {
      expect(maskAccount('+86 138-0013-8000')).toBe('+86****8000');
    });

    it('≤7 位数字：整体"***"（不留可识别片段）', () => {
      expect(maskAccount('1234567')).toBe('***');
    });

    it('非邮箱非手机（用户名等）：原样返回（非 PII，保留可追踪）', () => {
      expect(maskAccount('alice')).toBe('alice');
    });
  });

  describe('truncate', () => {
    it('超长截断到 max', () => {
      expect(truncate('A'.repeat(300), 255)).toHaveLength(255);
    });

    it('未超长原样返回', () => {
      expect(truncate('1.2.3.4', 45)).toBe('1.2.3.4');
    });

    it('null/undefined → null（不落占位空串）', () => {
      expect(truncate(null, 45)).toBeNull();
      expect(truncate(undefined, 45)).toBeNull();
    });
  });

  describe('isUniqueViolation', () => {
    it('driverError.code === 23505 → true（鸭子类型，跨 mock 一致）', () => {
      expect(isUniqueViolation({ driverError: { code: '23505' } })).toBe(true);
      expect(isUniqueViolation(new Error('boom'))).toBe(false);
      expect(isUniqueViolation(null)).toBe(false);
    });
  });
});
