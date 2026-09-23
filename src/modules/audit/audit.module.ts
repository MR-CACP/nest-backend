import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { User } from '../auth/entities/user.entity';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditLog } from './entities/audit-log.entity';
import { LoginLog } from './entities/login-log.entity';

/**
 * 审计模块：登录日志（login_logs）+ 管理操作审计（audit_logs）的写入与查询。
 * 模块结构说明：
 * - **登录日志的写入方在 AuthModule**：auth.service 直接注入 LoginLog 仓库
 *   （实体全局注册，forFeature 只提供注入器）——若本模块被 AuthModule import
 *   会形成 AuthModule → AuditModule → AuthModule 循环依赖，故这里刻意不 export
 *   写入服务给 auth，auth 自持 LoginLogRepository；
 * - 查询接口（/audit/*）需要 JwtAuthGuard/RolesGuard → import AuthModule：
 *   守卫类在消费模块上下文实例化——JwtService 由 AuthModule 导出；RolesGuard 唯一
 *   注入依赖是 Repository<User>，由本模块自身 forFeature([User]) 提供，依赖自包含。
 *   注意：sessions/users 模块 import RbacModule 是为了权限点常量，本模块守卫不依赖
 *   RbacModule，不要照抄那边照搬 import（守卫解析不依赖它，多 import 是噪音）；
 * - Users/Sessions/Rbac 模块 import 本模块，注入 AuditService 记录管理操作。
 */
@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([AuditLog, LoginLog, User])],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
