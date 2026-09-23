import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { User } from '../../src/modules/auth/entities/user.entity';
import { Role } from '../../src/modules/rbac/entities/role.entity';
import { UserRole } from '../../src/modules/rbac/entities/user-role.entity';

/** 响应信封类型（只取用到的字段） */
type Envelope<T> = { code: number; message: string; data: T };

/** 在线会话列表页 */
type SessionPage = {
  items: Array<{ id: string; userId: string; username: string }>;
  total: number;
};

/**
 * 会话管理 e2e（真库）：在线列表 + 单会话下线 + 全部下线（版本号踢 access）。
 * 依赖迁移已应用（含 InitSessionPermissions）。
 * 覆盖：admin 列表（username 筛选）→ 单会话下线后该 refresh 刷新 401 →
 * 全部下线后旧 access 即时 401（session_version 递增）→ 重新登录恢复 →
 * 权限点隔离（无 session:read 的普通用户 403）。
 * 注意：beforeEach 每用例重建 app——限速桶独立（同 auth e2e 模式）。
 */
describe('会话管理 (e2e)', () => {
  let app: INestApplication<App>;
  let roles: Repository<Role>;
  let userRoles: Repository<UserRole>;
  let users: Repository<User>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    roles = app.get(getRepositoryToken(Role));
    userRoles = app.get(getRepositoryToken(UserRole));
    users = app.get(getRepositoryToken(User));
  });

  afterEach(async () => {
    await app.close();
  });

  const suffix = () =>
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  /** 注册 + 登录，返回 { username, accessToken, refreshToken } */
  const registerAndLogin = async (prefix: string) => {
    const username = `${prefix}_${suffix()}`;
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ username, password: 'secret123' })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: username, password: 'secret123' })
      .expect(200);
    const data = (
      login.body as Envelope<{
        accessToken: string;
        refreshToken: string;
      }>
    ).data;
    return {
      username,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    };
  };

  /** 提升为 admin（直接写关联表） */
  const makeAdmin = async (userId: string): Promise<void> => {
    const role = await roles.findOneByOrFail({ code: 'admin' });
    await userRoles.save({ userId, roleId: role.id });
  };

  /** 登录后取 userId */
  const me = async (accessToken: string): Promise<string> => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    return (res.body as Envelope<{ id: string }>).data.id;
  };

  it('在线列表（筛选）+ 单会话下线 + 全部下线踢 access + 权限隔离', async () => {
    // admin 准备
    const admin = await registerAndLogin('adm_s');
    await makeAdmin(await me(admin.accessToken));

    // 普通用户：登录一次（一个在线会话）
    const u1 = await registerAndLogin('user_s');
    const u1Id = await me(u1.accessToken);
    // 第二个用户：仅用于权限隔离断言（无 session:read → 403）
    const u2 = await registerAndLogin('other_s');

    // 在线列表：username 筛选命中 u1 的会话，且只暴露安全字段
    const list = await request(app.getHttpServer())
      .get(`/api/sessions?username=${u1.username}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    const page = (list.body as Envelope<SessionPage>).data;
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.items[0].username).toBe(u1.username);
    expect(page.items[0]).not.toHaveProperty('tokenHash');
    const sessionId = page.items[0].id;

    // 单会话下线：撤销该 refresh 行 → 刷新 401（会话已终止）
    await request(app.getHttpServer())
      .delete(`/api/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: u1.refreshToken })
      .expect(401);

    // 全部下线：撤销全部 + 递增 session_version → 旧 access 即时 401（不等 15 分钟窗口）
    await request(app.getHttpServer())
      .delete(`/api/users/${u1Id}/sessions`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${u1.accessToken}`)
      .expect(401);

    // 重新登录：新 access 携带新版本号 → 恢复正常
    const relogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: u1.username, password: 'secret123' })
      .expect(200);
    const newAccess = (relogin.body as Envelope<{ accessToken: string }>).data
      .accessToken;
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${newAccess}`)
      .expect(200);

    // 权限点隔离：无 session:read 的普通用户调列表 → 403
    await request(app.getHttpServer())
      .get('/api/sessions')
      .set('Authorization', `Bearer ${u2.accessToken}`)
      .expect(403);
  });

  it('下线不存在的会话 → 404（REST 语义）', async () => {
    const admin = await registerAndLogin('adm_s2');
    await makeAdmin(await me(admin.accessToken));

    // refresh_tokens.id 是 bigint：传数字格式但不存在（UUID 会触发 22P02 → 400）
    await request(app.getHttpServer())
      .delete('/api/sessions/999999999999')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(404);
  });

  it('全部下线不存在的用户 → 404', async () => {
    const admin = await registerAndLogin('adm_s3');
    await makeAdmin(await me(admin.accessToken));

    await request(app.getHttpServer())
      .delete('/api/users/999999999999/sessions')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(404);
  });

  it('降级防护：非 admin（持 session:revoke）下线管理员 → 403；下线普通用户 → 200', async () => {
    const admin = await registerAndLogin('adm_d');
    const adminId = await me(admin.accessToken);
    await makeAdmin(adminId);

    // 造角色 session-ops（只绑 session:revoke）并分配给操作者
    const role = (
      await request(app.getHttpServer())
        .post('/api/roles')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ code: `sessops${suffix()}`, name: '会话操作员' })
        .expect(201)
    ).body as Envelope<{ id: string }>;
    const perms = (
      await request(app.getHttpServer())
        .get('/api/permissions')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200)
    ).body as Envelope<Array<{ id: string; code: string }>>;
    const sessionRevoke = perms.data.find((p) => p.code === 'session:revoke');
    expect(sessionRevoke).toBeDefined();
    await request(app.getHttpServer())
      .put(`/api/roles/${role.data.id}/permissions`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ permissionIds: [sessionRevoke!.id] })
      .expect(200);

    const ops = await registerAndLogin('ops_d');
    const opsId = await me(ops.accessToken);
    await request(app.getHttpServer())
      .put(`/api/users/${opsId}/roles`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ roleIds: [role.data.id] })
      .expect(200);

    // 非 admin 下线管理员账号 → 403（降级防护：与"改角色/状态"同口径）
    await request(app.getHttpServer())
      .delete(`/api/users/${adminId}/sessions`)
      .set('Authorization', `Bearer ${ops.accessToken}`)
      .expect(403);

    // 对照：下线普通用户 → 200（session:revoke 正常生效）
    const plain = await registerAndLogin('plain_d');
    const plainId = await me(plain.accessToken);
    await request(app.getHttpServer())
      .delete(`/api/users/${plainId}/sessions`)
      .set('Authorization', `Bearer ${ops.accessToken}`)
      .expect(200);

    // 单会话入口同口径：ops 也撤销不了 admin 的单个会话（防"全部下线"防护被绕过）
    const adminSessions = (
      await request(app.getHttpServer())
        .get(`/api/sessions?userId=${adminId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200)
    ).body as Envelope<SessionPage>;
    expect(adminSessions.data.items.length).toBeGreaterThanOrEqual(1);
    await request(app.getHttpServer())
      .delete(`/api/sessions/${adminSessions.data.items[0].id}`)
      .set('Authorization', `Bearer ${ops.accessToken}`)
      .expect(403);
  });

  it('软删用户的活跃会话：不出现在在线列表，且刷新已失效（访问侧 401）', async () => {
    const admin = await registerAndLogin('adm_soft');
    await makeAdmin(await me(admin.accessToken));

    const soft = await registerAndLogin('soft_u');
    const softId = await me(soft.accessToken);

    // 软删（当前无删除接口，直写 deleted_at）：软删是 UPDATE，
    // 不触发 refresh_tokens 的 DB 级 onDelete CASCADE，其未撤销/未过期行仍存在
    await users.update(softId, { deletedAt: new Date() });

    // 列表：TypeORM join 对带 @DeleteDateColumn 的关系自动追加 u.deleted_at IS NULL，
    // 软删用户的会话不出现在"在线"列表（钉住该行为，防 TypeORM 升级后语义漂移）
    const list = await request(app.getHttpServer())
      .get(`/api/sessions?username=${soft.username}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect((list.body as Envelope<SessionPage>).data.total).toBe(0);

    // 访问侧：refresh 查用户默认过滤软删 → null → 401（安全无洞的实证）
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: soft.refreshToken })
      .expect(401);
  });

  it('并发刷新与全部下线：最终无有效会话（用户行锁串行化收敛）', async () => {
    const admin = await registerAndLogin('adm_cr');
    const adminId = await me(admin.accessToken);
    await makeAdmin(adminId);

    const u = await registerAndLogin('u_cr');
    const uid = await me(u.accessToken);

    // 并发发出：刷新轮换 vs 全部下线。两者都以"锁用户行"串行，交错顺序二选一：
    // · 刷新先提交 → 全部下线撤销包括新插入的行 → 新 refresh 再刷 401；
    // · 全部下线先提交 → 刷新 CAS 匹配不到已撤销旧行 → 401（无新对）。
    // 断言不依赖交错顺序，只要求"最终该用户不能续期旧会话"。
    const [refreshRes, revokeRes] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: u.refreshToken })
        .expect((r) => {
          expect([200, 401]).toContain(r.status);
        }),
      request(app.getHttpServer())
        .delete(`/api/users/${uid}/sessions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200),
    ]);
    expect(revokeRes.status).toBe(200);

    // 收敛断言：无论交错顺序，幸存令牌（新对或原令牌）都无法再续期
    const survivorRt =
      refreshRes.status === 200
        ? (
            refreshRes.body as Envelope<{
              accessToken: string;
              refreshToken: string;
            }>
          ).data.refreshToken
        : u.refreshToken;
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: survivorRt })
      .expect(401);
    // 旧 access 已因版本 +1 永久失效（全部下线递增 session_version）
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${u.accessToken}`)
      .expect(401);
  });
});
