import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 审计权限点种子：幂等插入 1 个审计域权限码（查看登录日志 / 管理操作审计）。
 * 与 InitSessionPermissions 同一模式：只增不删；INSERT ... WHERE NOT EXISTS 幂等；
 * 内联值规避 INSERT...SELECT 的 42P08 参数类型推断冲突。
 */
export class InitAuditPermissions1790070000000 implements MigrationInterface {
  name = 'InitAuditPermissions1790070000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const permissions: Array<[string, string, string, string]> = [
      [
        'audit:read',
        '查看审计日志',
        '审计',
        '分页查看登录日志与管理操作审计（含成功/失败、操作者、动作、资源）',
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
      [['audit:read']],
    );
  }
}
