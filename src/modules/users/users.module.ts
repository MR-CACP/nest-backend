import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { User } from '../auth/entities/user.entity';
import { Role } from '../rbac/entities/role.entity';
import { UserRole } from '../rbac/entities/user-role.entity';
import { RbacModule } from '../rbac/rbac.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * 用户管理模块：用户资源上的管理操作（分页列表 / 角色分配）。
 * 与 RBAC 的分工：/api/users 归本模块，rbac 只管 /roles、/permissions。
 * 依赖说明：
 * - AuthModule：UsersController 使用 JwtAuthGuard（其解析需要 JwtService，由 AuthModule 导出）；
 * - RbacModule：UsersController 使用 RolesGuard（授权判定 + admin 旁路），由 RbacModule 导出；
 * - TypeOrmModule.forFeature([User, Role, UserRole])：实体可被多个模块 forFeature
 *   （TypeORM 实体全局注册，forFeature 只提供本模块的仓库注入器）。
 */
@Module({
  imports: [
    AuthModule,
    AuditModule,
    RbacModule,
    TypeOrmModule.forFeature([User, Role, UserRole]),
  ],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
