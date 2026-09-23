import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 分页排序索引：管理端列表（用户 / 在线会话）按 (created_at DESC, id DESC) 双键
 * 排序保证 offset 翻页稳定（同时间戳行不漂移），复合索引覆盖排序路径避免文件排序。
 * 实体侧同步声明（user.entity / refresh-token.entity 的 @Index），防 schema:log 漂移。
 * 幂等：IF NOT EXISTS，重跑不重复建。
 */
export class InitPaginationIndexes1790080000000 implements MigrationInterface {
  name = 'InitPaginationIndexes1790080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_users_created_id" ON "users" ("created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_created_id" ON "refresh_tokens" ("created_at", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_refresh_tokens_created_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_users_created_id"`,
    );
  }
}
