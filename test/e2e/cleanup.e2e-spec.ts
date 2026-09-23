import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { AuditLog } from '../../src/modules/audit/entities/audit-log.entity';
import { LoginLog } from '../../src/modules/audit/entities/login-log.entity';
import { RefreshToken } from '../../src/modules/auth/entities/refresh-token.entity';
import { User } from '../../src/modules/auth/entities/user.entity';
import { CleanupService } from '../../src/modules/cleanup/cleanup.service';

/**
 * 定时清理 e2e（真库）：直接调用 CleanupService 的清理方法（不等待 cron 触发——
 * cron 每日 03:00 不可在测试窗口内到达，服务方法即任务本体）。
 * 验证：
 * - refresh_tokens：过期超过保留期（默认 30 天）的行被物理删除，未过期行保留；
 * - login_logs / audit_logs：超过保留期（默认 180 天）的行被删除，近期行保留；
 * - 在线判定语义（revoked_at IS NULL 且未过期）不受清理影响。
 */
describe('Cleanup (e2e)', () => {
  let app: INestApplication<App>;
  let cleanup: CleanupService;
  let users: Repository<User>;
  let refreshTokens: Repository<RefreshToken>;
  let loginLogs: Repository<LoginLog>;
  let auditLogs: Repository<AuditLog>;

  const suffix = Date.now();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    cleanup = app.get(CleanupService);
    users = app.get(getRepositoryToken(User));
    refreshTokens = app.get(getRepositoryToken(RefreshToken));
    loginLogs = app.get(getRepositoryToken(LoginLog));
    auditLogs = app.get(getRepositoryToken(AuditLog));
  });

  afterAll(async () => {
    await app.close();
  });

  it('refresh_tokens：过期超 30 天删除、未过期保留', async () => {
    const user = await users.save({
      username: `cleanup_e2e_${suffix}`,
      passwordHash: 'x',
    });

    const staleToken = await refreshTokens.save({
      userId: user.id,
      tokenHash: `stale_${suffix}`,
      expiresAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    });
    const liveToken = await refreshTokens.save({
      userId: user.id,
      tokenHash: `live_${suffix}`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await cleanup.cleanExpiredRefreshTokens();

    await expect(
      refreshTokens.findOneByOrFail({ id: staleToken.id }),
    ).rejects.toThrow();
    // 未过期行保留（在线列表数据源不受影响）
    await expect(
      refreshTokens.findOneByOrFail({ id: liveToken.id }),
    ).resolves.toBeDefined();
  });

  it('审计表：超 180 天删除、近期行保留', async () => {
    // audit_logs.operator_id 是 FK（ON DELETE SET NULL），需真实用户
    const user = await users.save({
      username: `cleanup_audit_e2e_${suffix}`,
      passwordHash: 'x',
    });
    const staleLogin = await loginLogs.save({
      account: `cleanup_e2e_${suffix}`,
      success: true,
    });
    // @CreateDateColumn 在 save 时自动填当前时间，需显式 UPDATE 回拨到 200 天前
    //（清理判定按 created_at，不按插入时刻）
    await loginLogs.update(
      { id: staleLogin.id },
      { createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) },
    );
    const freshLogin = await loginLogs.save({
      account: `cleanup_e2e_${suffix}`,
      success: true,
    });
    const staleAudit = await auditLogs.save({
      action: 'user.update',
      resourceType: 'user',
      resourceId: user.id,
      operatorId: user.id,
      detail: { source: 'cleanup-e2e' },
    });
    await auditLogs.update(
      { id: staleAudit.id },
      { createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) },
    );

    await cleanup.cleanAuditLogs();

    await expect(
      loginLogs.findOneByOrFail({ id: staleLogin.id }),
    ).rejects.toThrow();
    await expect(
      loginLogs.findOneByOrFail({ id: freshLogin.id }),
    ).resolves.toBeDefined();
    await expect(
      auditLogs.findOneByOrFail({ id: staleAudit.id }),
    ).rejects.toThrow();
  });
});
