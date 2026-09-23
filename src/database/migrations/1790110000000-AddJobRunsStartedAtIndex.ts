import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * job_runs 补 (started_at, id) 前导索引。
 * 背景：idx_job_runs_job_started_id 首列是 job_id，cleanup:job-runs 的
 * WHERE started_at < cutoff 无法命中它，随 job_runs 增长清理会反复全表扫；
 * 本索引让清理筛选与稳定分批排序（ORDER BY id）都走索引。
 * 用追加迁移而非就地改写 InitJobs：InitJobs 已在 dev/test 库执行过，
 * 追加迁移对已应用库无损（migration:run 即生效，无 schema 漂移）。
 */
export class AddJobRunsStartedAtIndex1790110000000 implements MigrationInterface {
  name = 'AddJobRunsStartedAtIndex1790110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_job_runs_started_id" ON "job_runs" ("started_at", "id") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_job_runs_started_id"`);
  }
}
