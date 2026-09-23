import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 定时任务权限点种子：幂等插入 5 个任务域权限码（管理端 CRUD + 手动执行 + 执行日志查看）。
 * 与 InitAuditPermissions 同一模式：只增不删；INSERT ... WHERE NOT EXISTS 幂等。
 */
export class InitJobPermissions1790100000000 implements MigrationInterface {
  name = 'InitJobPermissions1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const permissions: Array<[string, string, string, string]> = [
      ['job:read', '查看定时任务', '定时任务', '分页查看任务定义与执行日志'],
      [
        'job:create',
        '创建定时任务',
        '定时任务',
        '新建任务定义（动作码 + cron 表达式）',
      ],
      [
        'job:update',
        '更新定时任务',
        '定时任务',
        '修改任务定义与启停状态（热更新调度）',
      ],
      [
        'job:delete',
        '删除定时任务',
        '定时任务',
        '删除任务定义（执行日志保留）',
      ],
      [
        'job:run',
        '手动执行任务',
        '定时任务',
        '立即执行一次任务（跳过 cron 等待）',
      ],
    ];
    for (const [code, name, group, description] of permissions) {
      const esc = (v: string) => `'${v.replace(/'/g, "''")}'`;
      await queryRunner.query(
        `INSERT INTO "permissions" ("code", "name", "group", "description")
         SELECT ${esc(code)}, ${esc(name)}, ${esc(group)}, ${esc(description)}
         WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "code" = ${esc(code)})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "permissions" WHERE "code" = ANY($1)`,
      [['job:read', 'job:create', 'job:update', 'job:delete', 'job:run']],
    );
  }
}
