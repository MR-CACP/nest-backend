import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 定时任务数据模型：job_definitions（任务定义）+ job_runs（执行日志）。
 * 设计要点：
 * - 任务 = 动作码 + cron 表达式 + 启停状态，全部存库可页面维护（若依式动态调度）；
 * - 种子插入三条 cleanup 任务（幂等 WHERE NOT EXISTS 按 name 判重）——
 *   清理调度从 @Cron 静态装饰器迁移到本表驱动（JobService 启动时注册）；
 * - job_runs.job_id 外键 ON DELETE SET NULL：任务删除后执行历史保留；
 * - status 枚举（enabled/disabled、success/failed）不加 DB CHECK：
 *   约束名是 TypeORM 哈希不可手写，写路径全部经过 DTO @IsIn + 服务层校验；
 * - (job_id, started_at, id) 复合索引覆盖"按任务查日志 + 双键稳定分页"；
 *   (started_at, id) 前导索引由后续迁移 AddJobRunsStartedAtIndex 追加（清老日志用）。
 */
export class InitJobs1790090000000 implements MigrationInterface {
  name = 'InitJobs1790090000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "job_definitions" ("id" BIGSERIAL NOT NULL, "name" character varying(100) NOT NULL, "action_code" character varying(50) NOT NULL, "cron_expression" character varying(100) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'enabled', "remark" character varying(255), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_job_definitions" PRIMARY KEY ("id"), CONSTRAINT "UQ_job_definitions_name" UNIQUE ("name"))`,
    );
    // 任务列表分页按 (created_at, id)——表量级小（任务数封顶），不建分页索引，全表扫可接受
    await queryRunner.query(
      `CREATE INDEX "idx_job_definitions_status" ON "job_definitions" ("status") `,
    );
    await queryRunner.query(
      `CREATE TABLE "job_runs" ("id" BIGSERIAL NOT NULL, "job_id" bigint, "status" character varying(20) NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "finished_at" TIMESTAMP WITH TIME ZONE, "duration_ms" integer, "error_message" character varying(500), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_job_runs" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_job_runs_job_started_id" ON "job_runs" ("job_id", "started_at", "id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "job_runs" ADD CONSTRAINT "FK_job_runs_job" FOREIGN KEY ("job_id") REFERENCES "job_definitions"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    // 种子：把原 @Cron 静态任务迁进动态调度表（幂等；后续新增任务走管理端接口）
    const seedJobs: Array<[string, string, string, string]> = [
      [
        'cleanup-refresh-tokens',
        'cleanup:refresh-tokens',
        '0 3 * * *',
        '每日清理过期超过保留期的 refresh token（默认 30 天）',
      ],
      [
        'cleanup-audit-logs',
        'cleanup:audit-logs',
        '0 3 * * *',
        '每日清理超保留期的审计日志 login_logs / audit_logs（默认 180 天）',
      ],
      [
        'cleanup-job-runs',
        'cleanup:job-runs',
        '0 4 * * *',
        '每日清理超保留期的任务执行日志 job_runs（默认 180 天）',
      ],
    ];
    for (const [name, actionCode, cronExpression, remark] of seedJobs) {
      const esc = (v: string) => `'${v.replace(/'/g, "''")}'`;
      await queryRunner.query(
        `INSERT INTO "job_definitions" ("name", "action_code", "cron_expression", "status", "remark")
         SELECT ${esc(name)}, ${esc(actionCode)}, ${esc(cronExpression)}, 'enabled', ${esc(remark)}
         WHERE NOT EXISTS (SELECT 1 FROM "job_definitions" WHERE "name" = ${esc(name)})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "job_runs" DROP CONSTRAINT "FK_job_runs_job"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_job_runs_job_started_id"`,
    );
    await queryRunner.query(`DROP TABLE "job_runs"`);
    await queryRunner.query(`DROP INDEX "public"."idx_job_definitions_status"`);
    await queryRunner.query(`DROP TABLE "job_definitions"`);
  }
}
