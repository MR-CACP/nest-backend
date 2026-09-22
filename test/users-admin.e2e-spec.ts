import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';

/** 响应信封类型（只取用到的字段） */
type Envelope<T> = { code: number; message: string; data: T };

/**
 * 用户管理端 e2e（真库）：管理端创建/改资料/改状态 + 用户自助 /me。
 * 依赖迁移已应用（含 InitUserPermissions）。
 * 覆盖：admin 创建用户 → 新用户可登录 → 改资料 → 自助改资料 →
 * 禁用后登录被拒 → 恢复 → 权限点隔离（非授权 403）。
 * 注意：beforeEach 每用例重建 app——限速桶独立（同 auth e2e 模式），
 * 避免用例间共享 THROTTLE_LIMIT 计数触发 429。
 */
describe('用户管理 (e2e)', () => {
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

  const suffix = () =>
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  /** 注册 + 登录，返回 access token */
  const registerAndLogin = async (prefix: string): Promise<string> => {
    const username = `${prefix}_${suffix()}`;
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ username, password: 'secret123' })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: username, password: 'secret123' })
      .expect(200);
    return (login.body as Envelope<{ accessToken: string }>).data.accessToken;
  };

  /** 提升为 admin（直接写关联表） */
  const makeAdmin = async (userId: string): Promise<void> => {
    const role = await roles.findOneByOrFail({ code: 'admin' });
    await userRoles.save({ userId, roleId: role.id });
  };

  it('admin 全链路：创建用户 → 登录 → 管理端改资料 → 自助改资料 → 禁用终止会话 → 恢复', async () => {
    // admin 准备
    const adminToken = await registerAndLogin('adm');
    const adminMe = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await makeAdmin((adminMe.body as Envelope<{ id: string }>).data.id);

    // 管理端创建用户（含规范化输入：标识全随机，重复运行不冲突）
    const username = `staff_${suffix()}`;
    const email = `staff${suffix()}@example.com`;
    const phone = `+86${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
    const created = await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        username,
        password: 'secret123',
        // DTO 正则与注册一致（不 trim/不去分隔符）：邮箱可大写（service 层小写化）
        email: email.toUpperCase(),
        phone,
        nickname: '员工',
      })
      .expect(201);
    const user = (created.body as Envelope<{ id: string }>).data;
    expect(user.id).toBeDefined();
    // P1：管理端响应绝不带出摘要/内部列（passwordHash/sessionVersion/deletedAt）
    expect(user).not.toHaveProperty('passwordHash');
    expect(user).not.toHaveProperty('sessionVersion');
    expect(user).not.toHaveProperty('deletedAt');

    // 新用户能登录（规范化标识：邮箱小写与登录路由一致）
    const loginByEmail = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: email, password: 'secret123' })
      .expect(200);
    const staffToken = (loginByEmail.body as Envelope<{ accessToken: string }>)
      .data.accessToken;

    // 管理端改资料（昵称/头像/备注）
    await request(app.getHttpServer())
      .patch(`/api/users/${user.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        nickname: '高级员工',
        avatarUrl: 'https://x/a.png',
        remark: '测试',
      })
      .expect(200);

    // 自助改资料（改自己的昵称/性别）
    const mePatch = await request(app.getHttpServer())
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ nickname: '自助昵称', gender: 'female' })
      .expect(200);
    const meData = (
      mePatch.body as Envelope<{ nickname: string; gender: string }>
    ).data;
    expect(meData.nickname).toBe('自助昵称');
    expect(meData.gender).toBe('female');

    // 重复用户名创建 → 409
    await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username, password: 'secret123' })
      .expect(409);

    // 禁用：登录被拒（bizCode 10001，HTTP 200）
    await request(app.getHttpServer())
      .patch(`/api/users/${user.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'disabled' })
      .expect(200);
    const disabledLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: username, password: 'secret123' })
      .expect(200); // 业务码契约：HTTP 200 + X-Business-Code
    expect((disabledLogin.body as Envelope<null>).code).toBe(10001);

    // 恢复 active：重新登录成功
    await request(app.getHttpServer())
      .patch(`/api/users/${user.id}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'active' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: username, password: 'secret123' })
      .expect(200);

    // 管理端列表：新用户可见
    const list = await request(app.getHttpServer())
      .get('/api/users?page=1&pageSize=100')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const page = (list.body as Envelope<{ items: { username: string }[] }>)
      .data;
    expect(page.items.map((u) => u.username)).toContain(username);
  });

  it('权限点隔离：普通用户（非 admin）调用管理端创建接口 → 403', async () => {
    const token = await registerAndLogin('plain');
    await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ username: `x_${suffix()}`, password: 'secret123' })
      .expect(403);
    await request(app.getHttpServer())
      .patch('/api/users/1/status')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'disabled' })
      .expect(403);
  });

  it('提权防护：拥有 user:assign-role 的非 admin 无法把自己提升为 admin（403）', async () => {
    // 准备 admin
    const adminToken = await registerAndLogin('adm_esc');
    const adminMe = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await makeAdmin((adminMe.body as Envelope<{ id: string }>).data.id);

    // admin 创建角色 role-manager 并绑 user:assign-role 权限
    const perms = await request(app.getHttpServer())
      .get('/api/permissions')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const permList = (perms.body as Envelope<{ id: string; code: string }[]>)
      .data;
    const assignRolePerm = permList.find((p) => p.code === 'user:assign-role')!;
    const managerRole = (
      await request(app.getHttpServer())
        .post('/api/roles')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: `manager${suffix()}`, name: '角色管理员' })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    await request(app.getHttpServer())
      .put(`/api/roles/${managerRole.data.id}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionIds: [assignRolePerm.id] })
      .expect(200);

    // 操作者：注册 + 被 admin 分配 role-manager（拥有 user:assign-role 但不是 admin）
    const operatorToken = await registerAndLogin('op_esc');
    const opMe = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    const operatorId = (opMe.body as Envelope<{ id: string }>).data.id;
    await request(app.getHttpServer())
      .put(`/api/users/${operatorId}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roleIds: [managerRole.data.id] })
      .expect(200);

    // 攻击尝试：给自己分配 admin 角色 → 403（提权防护，而非 200）
    const roles = await request(app.getHttpServer())
      .get('/api/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const adminRole = (
      roles.body as Envelope<{ id: string; code: string }[]>
    ).data.find((r) => r.code === 'admin')!;
    await request(app.getHttpServer())
      .put(`/api/users/${operatorId}/roles`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ roleIds: [adminRole.id] })
      .expect(403);

    // 对照：分配自己已拥有的 role-manager → 200（子集放行）
    await request(app.getHttpServer())
      .put(`/api/users/${operatorId}/roles`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ roleIds: [managerRole.data.id] })
      .expect(200);
  });

  it('降级防护：拥有 user:assign-role 的非 admin 无法剥离 admin 账号的角色（403）', async () => {
    // 准备两个账号：victim 提升为 admin；operator 绑定 role-manager（含 user:assign-role）
    const adminToken = await registerAndLogin('adm_dg');
    const adminMe = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const victimId = (adminMe.body as Envelope<{ id: string }>).data.id;
    await makeAdmin(victimId);

    const perms = await request(app.getHttpServer())
      .get('/api/permissions')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const permList = (perms.body as Envelope<{ id: string; code: string }[]>)
      .data;
    const assignRolePerm = permList.find((p) => p.code === 'user:assign-role')!;
    const managerRole = (
      await request(app.getHttpServer())
        .post('/api/roles')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code: `manager${suffix()}`, name: '角色管理员' })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    await request(app.getHttpServer())
      .put(`/api/roles/${managerRole.data.id}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionIds: [assignRolePerm.id] })
      .expect(200);

    const operatorToken = await registerAndLogin('op_dg');
    const opMe = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${operatorToken}`)
      .expect(200);
    const operatorId = (opMe.body as Envelope<{ id: string }>).data.id;
    await request(app.getHttpServer())
      .put(`/api/users/${operatorId}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roleIds: [managerRole.data.id] })
      .expect(200);

    // 攻击尝试：整体替换传 [] 清空 admin 账号的角色 → 403（降级防护）
    await request(app.getHttpServer())
      .put(`/api/users/${victimId}/roles`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ roleIds: [] })
      .expect(403);

    // 攻击尝试：禁用 admin 账号 → 403
    await request(app.getHttpServer())
      .patch(`/api/users/${victimId}/status`)
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ status: 'disabled' })
      .expect(403);

    // 对照：admin 自己管理 admin（旁路例外）→ 200
    await request(app.getHttpServer())
      .put(`/api/users/${victimId}/roles`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roleIds: [managerRole.data.id] })
      .expect(200);
  });

  it('并发安全：两个 admin 并发互禁，恰好一个成功一个 403，系统始终保留活跃 admin', async () => {
    // 准备 A、B 两个 admin
    const adminAToken = await registerAndLogin('adm_ca');
    const adminAMe = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminAToken}`)
      .expect(200);
    const adminAId = (adminAMe.body as Envelope<{ id: string }>).data.id;
    await makeAdmin(adminAId);
    const adminBToken = await registerAndLogin('adm_cb');
    const adminBMe = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminBToken}`)
      .expect(200);
    const adminBId = (adminBMe.body as Envelope<{ id: string }>).data.id;
    await makeAdmin(adminBId);

    // 收窄到恰好 2 个活跃 admin：删除其他用户的 admin 绑定
    //（测试库共享且 users 表无种子 admin；后续用例各自重新提升，不依赖历史绑定）
    const adminRole = await roles.findOneByOrFail({ code: 'admin' });
    await userRoles
      .createQueryBuilder()
      .delete()
      .where('role_id = :rid', { rid: adminRole.id })
      .andWhere('user_id NOT IN (:...ids)', { ids: [adminAId, adminBId] })
      .execute();

    // 并发互禁：事务内行锁使两个请求串行化——先到者 count=2 放行（200），
    // 后到者 count=1 触发最后 admin 保护（403）；无论谁先，恰好一个成功
    const [r1, r2] = await Promise.all([
      request(app.getHttpServer())
        .patch(`/api/users/${adminBId}/status`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ status: 'disabled' }),
      request(app.getHttpServer())
        .patch(`/api/users/${adminAId}/status`)
        .set('Authorization', `Bearer ${adminBToken}`)
        .send({ status: 'disabled' }),
    ]);
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([200, 403]);

    // 不变量：系统始终保留至少一个活跃 admin（不会因互禁锁死）
    const activeAdmins = await userRoles
      .createQueryBuilder('ur')
      .innerJoin(
        'users',
        'u',
        'u.id = ur.user_id AND u.status = :active AND u.deleted_at IS NULL',
        { active: 'active' },
      )
      .where('ur.role_id = :rid', { rid: adminRole.id })
      .getCount();
    expect(activeAdmins).toBeGreaterThanOrEqual(1);
  });

  it('未认证 → 401；用户不存在 → 404；非数字 ID → 400', async () => {
    await request(app.getHttpServer()).get('/api/users').expect(401);

    const adminToken = await registerAndLogin('adm404');
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await makeAdmin((me.body as Envelope<{ id: string }>).data.id);

    await request(app.getHttpServer())
      .patch('/api/users/99999999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nickname: 'x' })
      .expect(404);
    await request(app.getHttpServer())
      .patch('/api/users/99999999/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'disabled' })
      .expect(404);
    // P3：非数字 ID 打到 bigint 触发 PG 22P02，映射为 400 而非 500
    await request(app.getHttpServer())
      .patch('/api/users/abc')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nickname: 'x' })
      .expect(400);
  });
});
