import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitAuth1790010837665 implements MigrationInterface {
  name = 'InitAuth1790010837665';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "users" ("id" BIGSERIAL NOT NULL, "username" character varying(50) NOT NULL, "email" character varying(255), "phone" character varying(20), "password_hash" character varying(255), "nickname" character varying(50), "real_name" character varying(50), "gender" character varying(10), "birth_date" date, "avatar_url" character varying(500), "email_verified_at" TIMESTAMP WITH TIME ZONE, "phone_verified_at" TIMESTAMP WITH TIME ZONE, "status" character varying(20) NOT NULL DEFAULT 'active', "session_version" integer NOT NULL DEFAULT 0, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "remark" character varying(500), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_9ed5b32b1ae4555646e9f2c445" CHECK (gender IS NULL OR gender IN ('male', 'female', 'other')), CONSTRAINT "CHK_eb266885f4ca0639018d0c1f70" CHECK (status IN ('active', 'disabled', 'banned')), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    // 局部唯一索引（WHERE deleted_at IS NULL）：软删行不占用 username/email/phone，
    // 注销后标识可被重新注册；普通 UNIQUE 约束会把软删行一起判重，
    // 造成应用层"标识可用"与数据库 23505 的自相矛盾（见 user.entity.ts 注释）
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_username_active" ON "users" ("username") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_email_active" ON "users" ("email") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_phone_active" ON "users" ("phone") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "refresh_tokens" ("id" BIGSERIAL NOT NULL, "user_id" bigint NOT NULL, "token_hash" character varying(64) NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "revoked_at" TIMESTAMP WITH TIME ZONE, "user_agent" character varying(255), "ip" character varying(45), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_a7838d2ba25be1342091b6695f1" UNIQUE ("token_hash"), CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_expires" ON "refresh_tokens"  ("expires_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_refresh_tokens_user_revoked" ON "refresh_tokens"  ("user_id", "revoked_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_refresh_tokens_user_revoked"`,
    );
    await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_expires"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_users_phone_active"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_users_email_active"`);
    await queryRunner.query(`DROP INDEX "public"."UQ_users_username_active"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
