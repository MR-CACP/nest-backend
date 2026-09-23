import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RBAC 权限体系：roles / permissions / user_roles / role_permissions 四表。
 * 种子：两个系统角色（admin/user，is_system=true）——不可删除、不可改权限绑定，
 * 由应用层（管理端接口）强制；此处只负责落库，约束写进 role.entity.ts 注释。
 * admin 的权限判定是守卫硬编码旁路（见 roles.guard.ts 的 ADMIN_ROLE_CODE），
 * 因此不预置 role_permissions 数据。
 * 追加迁移（非就地改写）：InitAuth 之后所有 schema 变更一律追加新迁移。
 */
export class InitRbac1790020000000 implements MigrationInterface {
  name = 'InitRbac1790020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 权限点表：code 全局唯一（普通 UNIQUE——权限点不软删，无需局部索引）
    await queryRunner.query(
      `CREATE TABLE "permissions" ("id" BIGSERIAL NOT NULL, "code" character varying(100) NOT NULL, "name" character varying(50) NOT NULL, "group" character varying(50), "description" character varying(255), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_permissions_code" UNIQUE ("code"), CONSTRAINT "PK_permissions" PRIMARY KEY ("id"))`,
    );
    // 角色表：code 局部唯一索引（WHERE deleted_at IS NULL）——软删角色不占用 code
    await queryRunner.query(
      `CREATE TABLE "roles" ("id" BIGSERIAL NOT NULL, "code" character varying(50) NOT NULL, "name" character varying(50) NOT NULL, "description" character varying(255), "is_system" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_roles" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_roles_code_active" ON "roles" ("code") WHERE "deleted_at" IS NULL`,
    );
    // 用户-角色连接表（联合主键防重复分配；FK CASCADE 随用户/角色删除自动清理）
    await queryRunner.query(
      `CREATE TABLE "user_roles" ("user_id" bigint NOT NULL, "role_id" bigint NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_user_roles" PRIMARY KEY ("user_id", "role_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_roles" ADD CONSTRAINT "FK_user_roles_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_roles" ADD CONSTRAINT "FK_user_roles_role" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    // FK 列索引：TypeORM 不会为显式 @OneToMany 连接表自动建索引，
    // 手写迁移与实体 @Index 同步声明（对齐审计模块做法），避免按外键查询全表扫描
    await queryRunner.query(
      `CREATE INDEX "idx_user_roles_user" ON "user_roles" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_user_roles_role" ON "user_roles" ("role_id")`,
    );
    // 角色-权限连接表
    await queryRunner.query(
      `CREATE TABLE "role_permissions" ("role_id" bigint NOT NULL, "permission_id" bigint NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_role_permissions" PRIMARY KEY ("role_id", "permission_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_permissions" ADD CONSTRAINT "FK_role_permissions_role" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_permissions" ADD CONSTRAINT "FK_role_permissions_perm" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_role_permissions_role" ON "role_permissions" ("role_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_role_permissions_perm" ON "role_permissions" ("permission_id")`,
    );
    // 种子：系统角色（is_system=true）。INSERT ... WHERE NOT EXISTS 保证幂等
    //（重跑迁移不会重复插入；已有同名 code 时跳过）
    await queryRunner.query(
      `INSERT INTO "roles" ("code", "name", "description", "is_system") SELECT 'admin', '超级管理员', '系统内置：拥有全部权限（守卫旁路），不可修改/删除', true WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "code" = 'admin')`,
    );
    await queryRunner.query(
      `INSERT INTO "roles" ("code", "name", "description", "is_system") SELECT 'user', '普通用户', '系统内置：普通用户角色（种子示例；注册不自动分配，由管理员按需分配），无特殊权限', true WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "code" = 'user')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_role_permissions_perm"`);
    await queryRunner.query(`DROP INDEX "public"."idx_role_permissions_role"`);
    await queryRunner.query(`DROP TABLE "role_permissions"`);
    await queryRunner.query(`DROP INDEX "public"."idx_user_roles_role"`);
    await queryRunner.query(`DROP INDEX "public"."idx_user_roles_user"`);
    await queryRunner.query(`DROP TABLE "user_roles"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_roles_code_active"`);
    await queryRunner.query(`DROP TABLE "roles"`);
    await queryRunner.query(`DROP TABLE "permissions"`);
  }
}
