import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { User } from '../auth/entities/user.entity';
import { Permission } from './entities/permission.entity';
import { Role } from './entities/role.entity';
import { RolePermission } from './entities/role-permission.entity';
import { RbacController } from './rbac.controller';
import { RbacService } from './rbac.service';
import { RolesGuard } from './roles.guard';

/**
 * RBAC 权限体系模块：数据模型 + 授权守卫 + 管理端接口。
 * 使用方式：业务模块需要角色/权限控制时，
 * ① 控制器挂 @UseGuards(JwtAuthGuard, RolesGuard)（两守卫顺序执行：先认证后授权）；
 * ② 接口声明 @Permissions(PERMISSION_CODES.X)（权限码见 common/constants/rbac.constants）；
 * ③ 守卫经本模块注入的 User 仓库加载角色/权限判定。
 * 管理端接口（角色 CRUD / 权限分配）见 RbacController；用户列表与角色分配见 UsersModule。
 */
@Module({
  imports: [
    // RbacController 直接使用 JwtAuthGuard，需要 JwtService 在解析链上：
    // AuthModule 导出 JwtModule，import 后本模块控制器可解析（单向依赖，无循环）
    AuthModule,
    AuditModule,
    TypeOrmModule.forFeature([
      Role,
      Permission,
      RolePermission,
      // RolesGuard 构造注入 User 仓库（加载用户角色/权限判定），必须保留
      User,
    ]),
  ],
  controllers: [RbacController],
  providers: [RolesGuard, RbacService],
  // 只导出 RolesGuard/RbacService：TypeOrmModule 的再导出无消费者
  // （UsersModule 等各自 forFeature，实体仓库注入器由各模块自行提供），
  // 保留无效再导出只会掩盖依赖关系
  exports: [RolesGuard, RbacService],
})
export class RbacModule {}
