import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 会话管理权限点种子：幂等插入 2 个会话域权限码（查看在线列表 / 强制下线）。
 * 设计要点：
 * - 与 InitUserPermissions 同一模式：权限点由代码声明（PERMISSION_CODES），
 *   迁移只做登记；**只增不删**（删除 = 代码移除装饰器）；
 * - INSERT ... WHERE NOT EXISTS 幂等；内联值规避 INSERT...SELECT 的
 *   42P08 参数类型推断冲突（与 InitUserPermissions 同因）。
 */
export class InitSessionPermissions1790050000000 implements MigrationInterface {
  name = 'InitSessionPermissions1790050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const permissions: Array<[string, string, string, string]> = [
      [
        'session:read',
        '查看在线会话',
        '会话管理',
        '分页查看在线会话列表（可按用户筛选）',
      ],
      [
        'session:revoke',
        '强制下线',
        '会话管理',
        '下线单个会话或某用户全部会话（递增版本号即时踢出 access）',
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
      [['session:read', 'session:revoke']],
    );
  }
}
