import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { User } from '../auth/entities/user.entity';
import { RbacModule } from '../rbac/rbac.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

/**
 * 会话管理模块：在线列表 + 强制下线（管理端）。
 * 数据源是 refresh_tokens（认证模块的实体）+ users（session_version 递增踢 access）。
 * 依赖说明：
 * - AuthModule：SessionsController 使用 JwtAuthGuard（其解析需要 JwtService，由 AuthModule 导出）；
 * - RbacModule：SessionsController 使用 RolesGuard（授权判定 + admin 旁路），由 RbacModule 导出；
 * - TypeOrmModule.forFeature([RefreshToken, User])：实体可被多个模块 forFeature
 *   （TypeORM 实体全局注册，forFeature 只提供本模块的仓库注入器）。
 */
@Module({
  imports: [
    AuthModule,
    AuditModule,
    RbacModule,
    TypeOrmModule.forFeature([RefreshToken, User]),
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
})
export class SessionsModule {}
