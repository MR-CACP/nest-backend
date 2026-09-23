import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { In, Like, Not, Repository } from 'typeorm';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { AuditLog } from '../../src/modules/audit/entities/audit-log.entity';
import { RefreshToken } from '../../src/modules/auth/entities/refresh-token.entity';
import { JobDefinition } from '../../src/modules/jobs/entities/job-definition.entity';
import { JobRun } from '../../src/modules/jobs/entities/job-run.entity';
import { Role } from '../../src/modules/rbac/entities/role.entity';
import { UserRole } from '../../src/modules/rbac/entities/user-role.entity';

/**
 * 定时任务管理端 e2e：任务定义 CRUD + 启停 + 手动执行 + 执行日志（真库）。
 * 种子任务（InitJobs 迁移）已在 beforeAll 由 AppModule 启动注册，
 * 断言列表 3 条 = 验证"存库驱动 + 启动注册"整条链路。
 */
describe('Jobs (e2e)', () => {
  let app: INestApplication<App>;
  let refreshTokens: Repository<RefreshToken>;
  let jobs: Repository<JobDefinition>;
  let jobRuns: Repository<JobRun>;
  let auditLogs: Repository<AuditLog>;
  let roles: Repository<Role>;
  let userRoles: Repository<UserRole>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    refreshTokens = app.get(getRepositoryToken(RefreshToken));
    jobs = app.get(getRepositoryToken(JobDefinition));
    jobRuns = app.get(getRepositoryToken(JobRun));
    auditLogs = app.get(getRepositoryToken(AuditLog));
    roles = app.get(getRepositoryToken(Role));
    userRoles = app.get(getRepositoryToken(UserRole));
  });

  let admin: { token: string; userId: string };
  let plain: { token: string };

  afterAll(async () => {
    await app.close();
  });

  const suffix = (): string =>
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  /** 注册 + 登录 + /me，返回 token 与 userId；用户名加后缀避免重复运行冲突 */
  const registerAndLogin = async (
    prefix: string,
  ): Promise<{ token: string; userId: string }> => {
    const username = `${prefix}_${suffix()}`;
    const password = 'secret123';
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ username, password })
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
    return { token: body.data.accessToken, userId: meBody.data.id };
  };

  /** 给用户挂 admin 角色（admin 旁路 = 拥有全部权限点，含 job:*） */
  const grantAdmin = async (userId: string): Promise<void> => {
    const adminRole = await roles.findOneByOrFail({ code: 'admin' });
    await userRoles.save({ userId, roleId: adminRole.id });
  };

  beforeAll(async () => {
    admin = await registerAndLogin('job_admin');
    await grantAdmin(admin.userId);
    plain = await registerAndLogin('job_plain');

    // 测试库在多次运行间累积 manual_*/todelete_* 残留（随机名、无清理），
    // 会把种子任务挤出列表第一页。这里清掉非种子行，让"列表 3 条种子"断言稳定；
    // 种子行保留（InitJobs 迁移创建，验证存库驱动 + 启动注册链路）。
    const seedNames = [
      'cleanup-refresh-tokens',
      'cleanup-audit-logs',
      'cleanup-job-runs',
    ];
    // jobId 是 bigint：先取种子任务的 id 再按 id 过滤 job_runs（不能拿任务名去比 bigint）
    const seedJobs = await jobs.find({
      where: { name: In(seedNames) },
      select: { id: true },
    });
    await jobRuns.delete({ jobId: Not(In(seedJobs.map((j) => j.id))) });
    await jobs.delete({ name: Not(In(seedNames)) });
  });

  it('无 job:* 权限 → 403', async () => {
    await request(app.getHttpServer())
      .get('/api/jobs')
      .set('Authorization', `Bearer ${plain.token}`)
      .expect(403);
  });

  it('任务列表：种子 3 条（存库驱动 + 启动注册链路）', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/jobs?pageSize=10')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body = res.body as {
      data: { items: { name: string }[]; total: number };
    };
    expect(body.data.total).toBeGreaterThanOrEqual(3);
    const names = body.data.items.map((i) => i.name);
    expect(names).toContain('cleanup-refresh-tokens');
    expect(names).toContain('cleanup-audit-logs');
    expect(names).toContain('cleanup-job-runs');
  });

  it('创建任务：非法 cron → 400；合法 → 201 且注册；重名 → 409；审计 job.create 落库', async () => {
    const name = `manual_${suffix()}`;
    // 非法 cron：DTO 长度过 → 400
    await request(app.getHttpServer())
      .post('/api/jobs')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: `${name}_bad`,
        actionCode: 'cleanup:refresh-tokens',
        cronExpression: 'not-a-cron',
      })
      .expect(400);

    // 合法创建
    const created = await request(app.getHttpServer())
      .post('/api/jobs')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name,
        actionCode: 'cleanup:refresh-tokens',
        cronExpression: '0 5 * * *',
        remark: '手动创建',
      })
      .expect(201);
    const createdBody = created.body as { data: { id: string } };
    expect(createdBody.data.id).toBeDefined();

    // 重名 → 409
    await request(app.getHttpServer())
      .post('/api/jobs')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name,
        actionCode: 'cleanup:audit-logs',
        cronExpression: '0 6 * * *',
      })
      .expect(409);

    // 管理操作审计落库：job.create + 操作者（admin 的 userId）
    const auditRow = await auditLogs.findOneByOrFail({
      action: 'job.create',
      operatorId: admin.userId,
      resourceId: createdBody.data.id,
    });
    expect(auditRow.detail).toMatchObject({
      name,
      actionCode: 'cleanup:refresh-tokens',
    });
    expect(auditRow.ip).not.toBeNull();
  });

  it('更新 cron + 启停：热更新调度（改表达式后 run 仍成功）', async () => {
    const row = await jobs.findOneByOrFail({ name: 'cleanup-refresh-tokens' });

    // 改 cron（热更新注册）
    const updated = await request(app.getHttpServer())
      .patch(`/api/jobs/${row.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ cronExpression: '0 7 * * *' })
      .expect(200);
    const updatedBody = updated.body as { data: { cronExpression: string } };
    expect(updatedBody.data.cronExpression).toBe('0 7 * * *');

    // 停用 → 恢复启用
    await request(app.getHttpServer())
      .patch(`/api/jobs/${row.id}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'disabled' })
      .expect(200);
    await request(app.getHttpServer())
      .patch(`/api/jobs/${row.id}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'enabled' })
      .expect(200);
  });

  it('手动执行 cleanup:refresh-tokens：删除过期 token + 写 success 执行日志', async () => {
    // 造数据：一条过期（expiresAt 早于 cutoff=now-30d，严格小于才会被删）、一条未过期
    await refreshTokens.save({
      userId: admin.userId,
      tokenHash: `expired_${suffix()}`,
      expiresAt: new Date(Date.now() - 40 * 24 * 3600 * 1000),
      revokedAt: null,
      userAgent: null,
      ip: null,
    });
    const keepHash = `keep_${suffix()}`;
    await refreshTokens.save({
      userId: admin.userId,
      tokenHash: keepHash,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      revokedAt: null,
      userAgent: null,
      ip: null,
    });

    const row = await jobs.findOneByOrFail({ name: 'cleanup-refresh-tokens' });
    const res = await request(app.getHttpServer())
      .post(`/api/jobs/${row.id}/run`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body = res.body as { data: { status: string } };
    expect(body.data.status).toBe('success');

    // 过期行已删、未过期行保留
    const expiredLeft = await refreshTokens.countBy({
      userId: admin.userId,
      tokenHash: Like('expired_%'),
    });
    expect(expiredLeft).toBe(0);
    const keepRow = await refreshTokens.findOneBy({ tokenHash: keepHash });
    expect(keepRow).toBeDefined();

    // 执行日志：最近一条 success，关联 jobId
    const runRow = await jobRuns.findOneByOrFail({
      jobId: row.id,
      status: 'success',
    });
    expect(runRow.durationMs).not.toBeNull();
  });

  it('执行日志分页 + 结果筛选', async () => {
    const row = await jobs.findOneByOrFail({ name: 'cleanup-refresh-tokens' });
    const res = await request(app.getHttpServer())
      .get(`/api/jobs/${row.id}/runs?pageSize=5&status=success`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body = res.body as {
      data: { items: { status: string }[]; total: number };
    };
    expect(body.data.total).toBeGreaterThanOrEqual(1);
    expect(body.data.items.every((i) => i.status === 'success')).toBe(true);
  });

  it('删除任务：定义删除、该任务执行日志经 FK SET NULL 保留（jobId 置空）', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/jobs')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        name: `todelete_${suffix()}`,
        actionCode: 'cleanup:audit-logs',
        cronExpression: '0 9 * * *',
      })
      .expect(201);
    const id = (created.body as { data: { id: string } }).data.id;

    // 手动执行一次产生日志，先记下该 run 行 id（删除后按 id 精确断言）
    await request(app.getHttpServer())
      .post(`/api/jobs/${id}/run`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const runRow = await jobRuns.findOneByOrFail({
      jobId: id,
      status: 'success',
    });
    const runId = runRow.id;

    await request(app.getHttpServer())
      .delete(`/api/jobs/${id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);

    // 定义已删
    expect(await jobs.findOneBy({ id })).toBeNull();
    // 该任务的执行日志保留但 job_id 置空（ON DELETE SET NULL）
    // （此前用 orphan.some((r) => r.createdAt !== null) 断言：createdAt 恒非 null，
    //   条件恒真，退化为"存在孤儿行"——改为按 run 行 id 精确断言 jobId 置空）
    const orphan = await jobRuns.findOneByOrFail({ id: runId });
    expect(orphan.jobId).toBeNull();
  });
});
