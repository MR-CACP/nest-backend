import { getMetadataArgsStorage } from 'typeorm';

import { RefreshToken } from '@/modules/auth/entities/refresh-token.entity';
import { User } from '@/modules/auth/entities/user.entity';

/**
 * 认证实体元数据测试：保护装饰器配置（列名/可空/唯一/默认值/外键/索引），
 * 防止迁移与实体漂移——改实体忘改迁移时这里会先红。
 * 不连数据库：通过 TypeORM 元数据存储断言实体定义。
 */
describe('Auth 实体', () => {
  const columnsOf = (target: unknown) =>
    getMetadataArgsStorage().columns.filter((col) => col.target === target);

  describe('User（users 表）', () => {
    const userColumns = columnsOf(User);
    const column = (name: string) =>
      userColumns.find((col) => col.propertyName === name);

    it('实例化时无 JS 默认值（默认值由数据库 DEFAULT 承担）', () => {
      const user = new User();
      expect(user.id).toBeUndefined();
      expect(user.username).toBeUndefined();
      expect(user.status).toBeUndefined();
    });

    it('登录标识列可空，唯一性由局部唯一索引承担（软删行不占用）', () => {
      const email = column('email');
      const phone = column('phone');
      expect(email?.options.nullable).toBe(true);
      expect(phone?.options.nullable).toBe(true);
      // 唯一性从 @Column unique 改为 @Index 局部唯一索引（WHERE deleted_at IS NULL）：
      // 软删行不占用标识，注销后用户名/邮箱/手机号可重新注册（与 InitAuth 迁移 DDL 对齐）
      const userIndices = getMetadataArgsStorage().indices.filter(
        (idx) => idx.target === User,
      );
      const uniqueActive = (col: string) =>
        userIndices.find((idx) => {
          const columns = Array.isArray(idx.columns) ? idx.columns : [];
          return (
            idx.unique === true &&
            columns.includes(col) &&
            idx.where?.includes('deleted_at')
          );
        });
      expect(uniqueActive('username')).toBeDefined();
      expect(uniqueActive('email')).toBeDefined();
      expect(uniqueActive('phone')).toBeDefined();
    });

    it('状态列带数据库默认值 active', () => {
      expect(column('status')?.options.default).toBe('active');
    });

    it('软删除与审计时间列映射正确', () => {
      expect(column('deletedAt')?.options.name).toBe('deleted_at');
      expect(column('deletedAt')?.options.type).toBe('timestamptz');
      expect(column('createdAt')?.options.name).toBe('created_at');
      expect(column('updatedAt')?.options.name).toBe('updated_at');
    });
  });

  describe('RefreshToken（refresh_tokens 表）', () => {
    const refreshColumns = columnsOf(RefreshToken);
    const column = (name: string) =>
      refreshColumns.find((col) => col.propertyName === name);

    it('令牌哈希唯一（防同令牌重复签发）', () => {
      expect(column('tokenHash')?.options.unique).toBe(true);
      expect(column('tokenHash')?.options.length).toBe(64);
    });

    it('外键关联 users 且级联删除', () => {
      const relation = getMetadataArgsStorage().relations.find(
        (rel) => rel.target === RefreshToken && rel.propertyName === 'user',
      );
      const joinColumn = getMetadataArgsStorage().joinColumns.find(
        (jc) => jc.target === RefreshToken,
      );
      expect(relation?.options.onDelete).toBe('CASCADE');
      expect(joinColumn?.name).toBe('user_id');
    });

    it('在线列表与过期清理索引存在', () => {
      const indices = getMetadataArgsStorage().indices.filter(
        (idx) => idx.target === RefreshToken,
      );
      expect(indices.map((idx) => idx.name)).toEqual(
        expect.arrayContaining([
          'idx_refresh_tokens_user_revoked',
          'idx_refresh_tokens_expires',
        ]),
      );
    });
  });
});
