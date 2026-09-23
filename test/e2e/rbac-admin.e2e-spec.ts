import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { Role } from '../../src/modules/rbac/entities/role.entity';
import { UserRole } from '../../src/modules/rbac/entities/user-role.entity';

/** 响应信封类型（只取用到的字段） */
type Envelope<T> = { code: number; message: string; data: T };

/**
 * RBAC 管理端 e2e（真库）：依赖迁移已应用（InitRbac + InitRbacPermissions）。
 * 覆盖：角色 CRUD 全链路、系统角色保护（403）、删除有关联角色（409）、
 * 权限分配、用户分配角色（即时生效）、非 admin 403、提权防护。
 * 注意：beforeEach 每用例重建 app——限速桶独立（register 5 次/分），
 * 用例数增长后共享 app 会撞限速。
 */
describe('RBAC 管理端 (e2e)', () => {
  let app: INestApplication<App>;
  let roles: Repository<Role>;
  let userRoles: Repository<UserRole>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    roles = app.get(getRepositoryToken(Role));
    userRoles = app.get(getRepositoryToken(UserRole));
  });

  afterEach(async () => {
    await app.close();
  });

  /** 注册 + 登录，返回 access token */
  const registerAndLogin = async (prefix: string): Promise<string> => {
    const username = `${prefix}_${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const password = 'secret123';
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ username, password })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: username, password })
      .expect(200);
    const body = login.body as Envelope<{ accessToken: string }>;
    return body.data.accessToken;
  };

  /** 给用户分配角色（直接操作关联表） */
  const assignRole = async (
    userId: string,
    roleCode: string,
  ): Promise<void> => {
    const role = await roles.findOneByOrFail({ code: roleCode });
    await userRoles.save({ userId, roleId: role.id });
  };

  it('admin 全链路：角色 CRUD + 系统角色保护 + 权限分配 + 用户分配', async () => {
    // 准备：注册用户 → 分配 admin 角色 → 登录
    const adminToken = await registerAndLogin('adm');
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const adminId = (me.body as Envelope<{ id: string }>).data.id;
    await assignRole(adminId, 'admin');

    // 角色列表：种子角色可见
    const listRes = await request(app.getHttpServer())
      .get('/api/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const list = (
      listRes.body as Envelope<
        { id: string; code: string; isSystem: boolean }[]
      >
    ).data;
    expect(list.map((r) => r.code)).toEqual(
      expect.arrayContaining(['admin', 'user']),
    );
    const adminRole = list.find((r) => r.code === 'admin')!;
    expect(adminRole.isSystem).toBe(true);

    // 创建角色（code 随机后缀：重复运行不冲突）
    const roleCode = `editor${Date.now().toString(36)}`;
    const created = await request(app.getHttpServer())
      .post('/api/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: roleCode, name: '编辑' })
      .expect(201);
    const editorRole = (created.body as Envelope<{ id: string; code: string }>)
      .data;
    expect(editorRole.code).toBe(roleCode);

    // 重复 code → 409
    await request(app.getHttpServer())
      .post('/api/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: roleCode, name: 'x' })
      .expect(409);

    // 更新角色（改名成功）
    await request(app.getHttpServer())
      .patch(`/api/roles/${editorRole.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '高级编辑', description: 'd' })
      .expect(200);

    // 系统角色保护：改/删一律 403
    await request(app.getHttpServer())
      .patch(`/api/roles/${adminRole.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'x' })
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/api/roles/${adminRole.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);

    // 权限点列表（迁移种子 6 个）
    const perms = await request(app.getHttpServer())
      .get('/api/permissions')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const permList = (perms.body as Envelope<{ id: string; code: string }[]>)
      .data;
    expect(permList.map((p) => p.code)).toEqual(
      expect.arrayContaining(['role:create', 'user:assign-role']),
    );

    // 给角色分配权限（整体替换）：绑 role:read + user:read
    const roleRead = permList.find((p) => p.code === 'role:read')!;
    const userRead = permList.find((p) => p.code === 'user:read')!;
    await request(app.getHttpServer())
      .put(`/api/roles/${editorRole.id}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionIds: [roleRead.id, userRead.id] })
      .expect(200);
    const afterAssign = await request(app.getHttpServer())
      .get('/api/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    // 用本次创建的随机 code 查找（旧实现 find 'editor' 依赖历史库残留角色，
    // dev/test 库 drop 重来后不成立——用例必须自包含、幂等）
    const editorAfter = (
      afterAssign.body as Envelope<
        { id: string; code: string; permissions: string[] }[]
      >
    ).data.find((r) => r.code === editorRole.code)!;
    expect(editorAfter.permissions).toEqual(
      expect.arrayContaining(['role:read', 'user:read']),
    );

    // 无效权限 ID → 400
    await request(app.getHttpServer())
      .put(`/api/roles/${editorRole.id}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionIds: ['999999'] })
      .expect(400);

    // 建一个"已分配"角色验证 409
    const linked = await request(app.getHttpServer())
      .post('/api/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: `tmp${Date.now().toString(36)}`, name: '临时' })
      .expect(201);
    const linkedRole = (linked.body as Envelope<{ id: string }>).data;
    const targetUser = (
      await request(app.getHttpServer())
        .get('/api/users?page=1&pageSize=5')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)
    ).body as Envelope<{ items: { id: string }[] }>;
    // 取一个普通注册用户（最后一个）
    const someUser = targetUser.data.items[0];
    await userRoles.save({ userId: someUser.id, roleId: linkedRole.id });
    await request(app.getHttpServer())
      .delete(`/api/roles/${linkedRole.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    await userRoles.delete({ userId: someUser.id, roleId: linkedRole.id });
    await request(app.getHttpServer())
      .delete(`/api/roles/${linkedRole.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // 用户列表分页
    const users = await request(app.getHttpServer())
      .get('/api/users?page=1&pageSize=5')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const page = (
      users.body as Envelope<{
        items: { id: string; roles: string[] }[];
        total: number;
      }>
    ).data;
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.items[0]).toHaveProperty('roles');

    // 给用户分配角色 → 即时生效（同一 token 无需重新登录）
    const plainToken = await registerAndLogin('plain');
    const plainMe = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${plainToken}`)
      .expect(200);
    const plainId = (plainMe.body as Envelope<{ id: string }>).data.id;
    // 分配前：无权限 → 403
    await request(app.getHttpServer())
      .get('/api/roles')
      .set('Authorization', `Bearer ${plainToken}`)
      .expect(403);
    // 分配 admin 角色
    await request(app.getHttpServer())
      .put(`/api/users/${plainId}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roleIds: [adminRole.id] })
      .expect(200);
    // 同一 token 立即有权限
    await request(app.getHttpServer())
      .get('/api/roles')
      .set('Authorization', `Bearer ${plainToken}`)
      .expect(200);
    // 清空角色 → 403 恢复
    await request(app.getHttpServer())
      .put(`/api/users/${plainId}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roleIds: [] })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/roles')
      .set('Authorization', `Bearer ${plainToken}`)
      .expect(403);
  });

  it('提权防护：拥有 role:assign-permission 的非 admin 无法授予自己没有的权限（403）', async () => {
    // 准备 admin
    const adminToken = await registerAndLogin('adm_esc');
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await assignRole((me.body as Envelope<{ id: string }>).data.id, 'admin');

    // 权限点列表
    const perms = await request(app.getHttpServer())
      .get('/api/permissions')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const permList = (perms.body as Envelope<{ id: string; code: string }[]>)
      .data;
    const assignPerm = permList.find(
      (p) => p.code === 'role:assign-permission',
    )!;
    const sensitivePerm = permList.find((p) => p.code === 'role:delete')!;

    // admin 建 role-manager（绑 role:assign-permission）+ 目标角色 target
    const managerRole = (
      await request(app.getHttpServer())
        .post('/api/roles')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: `permman${Date.now().toString(36)}`, name: '权限管理员' })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    await request(app.getHttpServer())
      .put(`/api/roles/${managerRole.data.id}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionIds: [assignPerm.id] })
      .expect(200);
    const targetRole = (
      await request(app.getHttpServer())
        .post('/api/roles')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: `target${Date.now().toString(36)}`, name: '目标' })
        .expect(201)
    ).body as Envelope<{ id: string }>;

    // 操作者：注册 + 分配 role-manager（自定义角色，直接按 id 写关联表）
    const operatorToken = await registerAndLogin('op_esc');
    const opMe = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    await userRoles.save({
      userId: (opMe.body as Envelope<{ id: string }>).data.id,
      roleId: managerRole.data.id,
    });

    // 攻击尝试：把 role:delete（自己未拥有的敏感权限）绑给 target 角色 → 403
    await request(app.getHttpServer())
      .put(`/api/roles/${targetRole.data.id}/permissions`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ permissionIds: [sensitivePerm.id] })
      .expect(403);

    // 对照：授予自己已拥有的 role:assign-permission → 200（子集放行）
    await request(app.getHttpServer())
      .put(`/api/roles/${targetRole.data.id}/permissions`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ permissionIds: [assignPerm.id] })
      .expect(200);
  });

  it('未认证 401 / 非 admin 用户 403', async () => {
    // 无令牌
    await request(app.getHttpServer()).get('/api/roles').expect(401);

    // 普通注册用户（无任何角色）
    const token = await registerAndLogin('nobody');
    await request(app.getHttpServer())
      .get('/api/roles')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('删除不存在的角色 → 404', async () => {
    const adminToken = await registerAndLogin('adm404');
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await assignRole((me.body as Envelope<{ id: string }>).data.id, 'admin');
    await request(app.getHttpServer())
      .delete('/api/roles/99999999')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });
});
