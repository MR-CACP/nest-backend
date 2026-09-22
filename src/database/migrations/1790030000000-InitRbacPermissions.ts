import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RBAC 管理端权限点种子：幂等插入 7 个管理权限码。
 * 设计要点：
 * - 权限点由代码声明（@Permissions 引用 common/constants/rbac.constants.ts 的
 *   PERMISSION_CODES），本迁移只做登记；**只增不删**（删除 = 代码移除装饰器）；
 * - 迁移自包含、不 import 运行时代码：历史快照必须固定当时的值，
 *   代码演进（如权限码改名）不能改变已应用迁移的行为；
 * - INSERT ... WHERE NOT EXISTS 幂等：重跑不重复插入；
 * - 不绑定到 admin 角色：admin 的权限判定是守卫硬编码旁路，
 *   role_permissions 保持为空，语义更清晰（旁路 = 全部，不靠绑定行表示）。
 */
export class InitRbacPermissions1790030000000 implements MigrationInterface {
  name = 'InitRbacPermissions1790030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const permissions: Array<[string, string, string, string]> = [
      ['role:read', '查看角色/权限', '角色管理', '查看角色与权限点列表'],
      ['role:create', '创建角色', '角色管理', '新建角色（code 唯一）'],
      [
        'role:update',
        '更新角色',
        '角色管理',
        '修改角色名称/描述（code 不可改）',
      ],
      [
        'role:delete',
        '删除角色',
        '角色管理',
        '删除角色（系统角色与已分配角色除外）',
      ],
      [
        'role:assign-permission',
        '分配角色权限',
        '角色管理',
        '给角色配置权限点（整体替换）',
      ],
      ['user:read', '查看用户', '用户管理', '查看用户列表（含角色）'],
      [
        'user:assign-role',
        '分配用户角色',
        '用户管理',
        '给用户分配角色（整体替换）',
      ],
    ];
    // 内联值（非参数化）：INSERT...SELECT 中 $1 同时出现在目标列与 WHERE，
    // PG 无法推断参数类型（42P08 inconsistent types）；种子值是固定常量，
    // 直接拼接 SQL 更简单，且与 InitRbac 种子的写法一致
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
    const codes = [
      'role:read',
      'role:create',
      'role:update',
      'role:delete',
      'role:assign-permission',
      'user:read',
      'user:assign-role',
    ];
    await queryRunner.query(
      `DELETE FROM "permissions" WHERE "code" = ANY($1)`,
      [codes],
    );
  }
}
