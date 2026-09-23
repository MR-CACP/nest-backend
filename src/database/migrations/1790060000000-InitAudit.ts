import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 审计数据模型：login_logs（登录日志）+ audit_logs（管理操作审计）。
 * 设计要点：
 * - login_logs 只记"登录"事件（register/refresh 不写本表）；account 只存脱敏值
 *   （maskAccount，不落 PII 明文），user_id 可空（失败且无用户）；
 * - audit_logs 追加式记录管理端写路径（users/rbac/sessions），operator_id 可空；
 * - 两个 user_id 外键均 ON DELETE SET NULL：用户被删后审计记录保留（审计完整性）；
 * - audit_logs.resource_id 不设外键（多态：user/role/session 的 id 形态不同）。
 */
export class InitAudit1790060000000 implements MigrationInterface {
  name = 'InitAudit1790060000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "login_logs" ("id" BIGSERIAL NOT NULL, "user_id" bigint, "account" character varying(255), "success" boolean NOT NULL DEFAULT false, "fail_reason" character varying(50), "ip" character varying(45), "user_agent" character varying(255), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_login_logs" PRIMARY KEY ("id"))`,
    );
    // 单列 created_at 不建：idx_login_logs_created_id 复合索引前缀已覆盖
    // （append-only 写密集表，少一个索引就是每行少一次 B-tree 维护）
    await queryRunner.query(
      `CREATE INDEX "idx_login_logs_user" ON "login_logs" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_login_logs_success_created" ON "login_logs" ("success", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_logs" ("id" BIGSERIAL NOT NULL, "operator_id" bigint, "action" character varying(100) NOT NULL, "resource_type" character varying(50) NOT NULL, "resource_id" character varying(64), "detail" jsonb, "ip" character varying(45), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id"))`,
    );
    // 单列 created_at 不建：idx_audit_logs_created_id 复合索引前缀已覆盖
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_operator" ON "audit_logs" ("operator_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_action" ON "audit_logs" ("action") `,
    );
    // resource_type 是公开筛选条件：单列索引避免追加式日志下的全表扫
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_resource_type" ON "audit_logs" ("resource_type") `,
    );
    // (created_at, id) 复合索引匹配双键稳定排序（无筛选的全表倒序页）：
    // 避免同时间戳多行时 offset 分页重复/遗漏，也为深分页提供索引支撑。
    // 建 ASC：TypeORM @Index 不支持 DESC，实体声明与此必须一致；PG 对倒序查询
    // 走 backward index scan，性能等价
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_created_id" ON "audit_logs" ("created_at", "id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_login_logs_created_id" ON "login_logs" ("created_at", "id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "login_logs" ADD CONSTRAINT "FK_login_logs_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "audit_logs" ADD CONSTRAINT "FK_audit_logs_operator" FOREIGN KEY ("operator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "audit_logs" DROP CONSTRAINT "FK_audit_logs_operator"`,
    );
    await queryRunner.query(
      `ALTER TABLE "login_logs" DROP CONSTRAINT "FK_login_logs_user"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_action"`);
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_operator"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_audit_logs_resource_type"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_audit_logs_created_id"`);
    await queryRunner.query(`DROP INDEX "public"."idx_login_logs_created_id"`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(
      `DROP INDEX "public"."idx_login_logs_success_created"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_login_logs_user"`);
    await queryRunner.query(`DROP TABLE "login_logs"`);
  }
}
