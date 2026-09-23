import { INestApplication, Module } from '@nestjs/common';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { Permissions, Roles } from '../../src/common/decorators/rbac.decorator';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { User } from '../../src/modules/auth/entities/user.entity';
import { JwtAuthGuard } from '../../src/modules/auth/jwt-auth.guard';
import { Role } from '../../src/modules/rbac/entities/role.entity';
import { UserRole } from '../../src/modules/rbac/entities/user-role.entity';
import { RbacModule } from '../../src/modules/rbac/rbac.module';
import { RolesGuard } from '../../src/modules/rbac/roles.guard';

/** 演示受保护接口：验证 @Roles/@Permissions 授权（真实守卫链路） */
@Controller('_rbac-demo')
@UseGuards(JwtAuthGuard, RolesGuard)
class RbacDemoController {
  /** 仅 admin 角色可访问 */
  @Get('admin-only')
  @Roles('admin')
  adminOnly(): { ok: true } {
    return { ok: true };
  }

  /** 拥有 user:delete 权限可访问（admin 旁路也放行） */
  @Get('perm-only')
  @Permissions('user:delete')
  permOnly(): { ok: true } {
    return { ok: true };
  }
}

/**
 * 测试专用模块：DemoController 必须声明在自己的模块里并 imports AuthModule/RbacModule，
 * 否则 JwtAuthGuard 的依赖（JwtService）无法从 RootTestModule 解析
 * （Nest 只对模块 exports 的能力可见）。
 * 注意：守卫类在消费模块上下文实例化——JwtAuthGuard 与 RolesGuard 都构造注入
 * User 仓库，本模块必须自身 forFeature([User])（RbacModule 不再再导出 TypeOrmModule，
 * 测试模块依赖必须自包含）。
 */
@Module({
  imports: [AuthModule, RbacModule, TypeOrmModule.forFeature([User])],
  controllers: [RbacDemoController],
})
class TestRbacModule {}

/**
 * RBAC e2e（真库）：依赖迁移已应用（InitRbac 含 admin/user 种子角色）。
 * 验证"每请求查库 → 角色分配即时生效"：同一 access token 在分配角色前 403、
 * 分配后 200（无需重新登录）——这正是该设计区别于 JWT 角色快照的核心。
 */
describe('RBAC (e2e)', () => {
  let app: INestApplication<App>;
  let roles: Repository<Role>;
  let userRoles: Repository<UserRole>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, TestRbacModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    roles = app.get(getRepositoryToken(Role));
    userRoles = app.get(getRepositoryToken(UserRole));
  });

  afterAll(async () => {
    await app.close();
  });

  /** 注册 + 登录，返回 access token；用户名加随机后缀（重复运行不冲突） */
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
    // 先断言 body 再访问（supertest 的 body 是 any，直接 .data 触发 no-unsafe）
    const body = login.body as { data: { accessToken: string } };
    return body.data.accessToken;
  };

  it('未分配角色：@Roles("admin") 接口 403（已认证但无权限）', async () => {
    const token = await registerAndLogin('rbac_plain');
    await request(app.getHttpServer())
      .get('/api/_rbac-demo/admin-only')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('分配 admin 角色后：同一 access token 立即放行（每请求查库即时生效）', async () => {
    const token = await registerAndLogin('rbac_admin');
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const userId = (me.body as { data: { id: string } }).data.id;
    const adminRole = await roles.findOneByOrFail({ code: 'admin' });
    await userRoles.save({ userId, roleId: adminRole.id });

    // 无需重新登录：guard 每请求查库，角色分配即时生效
    await request(app.getHttpServer())
      .get('/api/_rbac-demo/admin-only')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('/me 返回角色码：普通用户 roles 不含 admin，admin 用户含 admin', async () => {
    const plainToken = await registerAndLogin('rbac_me_plain');
    const plainMe = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${plainToken}`)
      .expect(200);
    expect((plainMe.body as { data: { roles: string[] } }).data.roles).toEqual(
      [],
    );

    const adminToken = await registerAndLogin('rbac_me_admin');
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const data = (me.body as { data: { id: string; roles: string[] } }).data;
    await userRoles.save({
      userId: data.id,
      roleId: (await roles.findOneByOrFail({ code: 'admin' })).id,
    });
    const after = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((after.body as { data: { roles: string[] } }).data.roles).toContain(
      'admin',
    );
  });
});
