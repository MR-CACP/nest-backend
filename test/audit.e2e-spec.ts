import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuditLog } from '../src/modules/audit/entities/audit-log.entity';
import { LoginLog } from '../src/modules/audit/entities/login-log.entity';
import { User } from '../src/modules/auth/entities/user.entity';
import { Role } from '../src/modules/rbac/entities/role.entity';
import { UserRole } from '../src/modules/rbac/entities/user-role.entity';

/**
 * 审计 e2e（真库）：依赖迁移已应用（InitAudit 建表 + InitAuditPermissions 登记 audit:read）。
 * 验证：
 * - 登录三态（成功 / 密码错误 / 账号禁用）写入 login_logs，account 脱敏、userId 正确关联；
 * - 管理操作（创建角色）写入 audit_logs；
 * - 查询接口 @Permissions(audit:read)：admin 放行、无权限 403、分页与过滤可用。
 * 注意：login/register 方法级限流 5 次/60s（THROTTLE_STORAGE=memory，suite 内共享），
 * 本 suite 刻意合并用户、把 login 总次数压到 4 次以内。
 */
describe('Audit (e2e)', () => {
  let app: INestApplication<App>;
  let loginLogs: Repository<LoginLog>;
  let auditLogs: Repository<AuditLog>;
  let roles: Repository<Role>;
  let userRoles: Repository<UserRole>;
  let users: Repository<User>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    loginLogs = app.get(getRepositoryToken(LoginLog));
    auditLogs = app.get(getRepositoryToken(AuditLog));
    roles = app.get(getRepositoryToken(Role));
    userRoles = app.get(getRepositoryToken(UserRole));
    users = app.get(getRepositoryToken(User));
  });

  // 共享用户：suite 内复用，把 login 总次数压到 4（login 方法级限流 5 次/60s）
  let admin: {
    token: string;
    userId: string;
    username: string;
    email: string;
  };
  let plain: { token: string; userId: string; username: string };

  beforeAll(async () => {
    admin = await registerAndLogin(
      'audit_admin',
      `audit${suffix()}@example.com`,
    );
    await grantAdmin(admin.userId);
    plain = await registerAndLogin('audit_plain');
  });

  afterAll(async () => {
    await app.close();
  });

  const suffix = (): string =>
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  /** 注册 + 登录 + /me，返回 token 与 userId；用户名加后缀避免重复运行冲突 */
  const registerAndLogin = async (
    prefix: string,
    email?: string,
  ): Promise<{
    token: string;
    userId: string;
    username: string;
    email: string;
  }> => {
    const username = `${prefix}_${suffix()}`;
    const password = 'secret123';
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ username, password, ...(email ? { email } : {}) })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: username, password })
      .expect(200);
    const body = login.body as { data: { accessToken: string } };
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${body.data.accessToken}`)
      .expect(200);
    const meBody = me.body as { data: { id: string } };
    return {
      token: body.data.accessToken,
      userId: meBody.data.id,
      username,
      email: email ?? '',
    };
  };

  /** 给用户挂 admin 角色（admin 旁路 = 拥有全部权限点，含 audit:read） */
  const grantAdmin = async (userId: string): Promise<void> => {
    const adminRole = await roles.findOneByOrFail({ code: 'admin' });
    await userRoles.save({ userId, roleId: adminRole.id });
  };

  it('登录成功写入 login_logs：success=true、userId 关联；admin 可查', async () => {
    // 登录日志：成功行 + userId 关联（admin 在 beforeAll 中已登录）
    const rows = await loginLogs.find({
      where: { userId: admin.userId },
      order: { createdAt: 'DESC' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const okRow = rows.find((r) => r.success === true);
    expect(okRow).toBeDefined();
    expect(okRow?.success).toBe(true);
    expect(okRow?.failReason).toBeNull();

    // admin 查询接口：200 + 分页 + ?success=true 过滤（items 全为成功行）
    const list = await request(app.getHttpServer())
      .get('/api/audit/login-logs?pageSize=5&success=true')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listBody = list.body as {
      data: { items: { success: boolean }[]; pageSize: number };
    };
    expect(listBody.data.pageSize).toBe(5);
    expect(listBody.data.items.length).toBeGreaterThanOrEqual(1);
    expect(listBody.data.items.every((i) => i.success === true)).toBe(true);

    // 非法 success 值 → 400（DTO 校验，不落到 SQL）
    await request(app.getHttpServer())
      .get('/api/audit/login-logs?success=notabool')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(400);
  });

  it('密码错误写入 login_logs：success=false + invalid_credentials，邮箱 account 脱敏入库', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: admin.email, password: 'wrong-pass' })
      .expect(401);

    const rows = await loginLogs.find({
      where: {
        userId: admin.userId,
        success: false,
        failReason: 'invalid_credentials',
      },
      order: { createdAt: 'DESC' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // 邮箱脱敏：a***@domain 形态，不落 PII 明文
    const latest = rows[0];
    expect(latest.account).toMatch(/^a\*\*\*@/);
    expect(latest.account).not.toContain(admin.email);
  });

  it('禁用账号登录写入 login_logs：account_disabled；无权限用户查询 403', async () => {
    // 无 audit:read 权限（未挂任何角色）：两个查询端点均 403
    await request(app.getHttpServer())
      .get('/api/audit/login-logs')
      .set('Authorization', `Bearer ${plain.token}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/audit/logs')
      .set('Authorization', `Bearer ${plain.token}`)
      .expect(403);

    // 禁用后登录：走 account_disabled（业务异常 HTTP 200 + code）。
    // 附加超长 UA（>255）：P1 回归——写入前必须按列宽裁剪，否则 INSERT 抛
    // 22001 被"尽力而为"吞掉后该次登录完全不留痕（审计被绕过）
    await users.update({ id: plain.userId }, { status: 'disabled' });
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: plain.username, password: 'secret123' })
      .set('User-Agent', 'Mozilla/5.0 ' + 'A'.repeat(300))
      .expect(200);

    const rows = await loginLogs.find({
      where: { userId: plain.userId, success: false },
      order: { createdAt: 'DESC' },
    });
    const disabledRow = rows.find((r) => r.failReason === 'account_disabled');
    expect(disabledRow).toBeDefined();
    expect(disabledRow?.userAgent).toHaveLength(255); // 截断而非 22001
  });

  it('管理操作写入 audit_logs：创建角色 → role.create，查询可过滤 action', async () => {
    // 两个查询端点 admin 放行（admin 为 beforeAll 共享用户）
    await request(app.getHttpServer())
      .get('/api/audit/login-logs')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/audit/logs')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    // 创建角色 → 审计落库（role.create + detail 摘要）
    await request(app.getHttpServer())
      .post('/api/roles')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ code: `audit-e2e-role-${suffix()}`, name: '审计e2e角色' })
      .expect(201);

    const rows = await auditLogs.find({
      where: { action: 'role.create', operatorId: admin.userId },
      order: { createdAt: 'DESC' },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const created = rows[0];
    expect(created.resourceType).toBe('role');
    // detail 含 code/name 摘要（不含敏感字段）
    expect(created.detail?.code).toBeDefined();

    // 查询接口 action 过滤命中
    const list = await request(app.getHttpServer())
      .get(`/api/audit/logs?action=role.create&operatorId=${admin.userId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const listBody = list.body as { data: { items: unknown[]; total: number } };
    expect(listBody.data.total).toBeGreaterThanOrEqual(1);
  });
});
