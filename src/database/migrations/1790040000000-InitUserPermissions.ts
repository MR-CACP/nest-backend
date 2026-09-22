import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 用户管理权限点种子：幂等插入 3 个用户域权限码（创建/改资料/改状态）。
 * 设计要点：
 * - 与 InitRbacPermissions 同一模式：权限点由代码声明（PERMISSION_CODES），
 *   迁移只做登记；**只增不删**（删除 = 代码移除装饰器）；
 * - 单独迁移而非并入 InitRbacPermissions：每个迁移是已应用的不可变历史，
 *   权限点按阶段落各自迁移，语义干净；
 * - INSERT ... WHERE NOT EXISTS 幂等；内联值规避 INSERT...SELECT 的
 *   42P08 参数类型推断冲突（与 InitRbacPermissions 同因）。
 */
export class InitUserPermissions1790040000000 implements MigrationInterface {
  name = 'InitUserPermissions1790040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const permissions: Array<[string, string, string, string]> = [
      ['user:create', '创建用户', '用户管理', '管理员代建用户（密码必填）'],
      [
        'user:update',
        '更新用户资料',
        '用户管理',
        '修改用户资料（不含登录标识与状态）',
      ],
      [
        'user:disable',
        '修改用户状态',
        '用户管理',
        '启用/禁用/封禁用户（非 active 即撤销全部会话）',
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
      [['user:create', 'user:update', 'user:disable']],
    );
  }
}
