import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import type { JwtConfig } from '../../config/types';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { User } from './entities/user.entity';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * JWT 模块装配（抽成纯函数便于单测）：
 * 配置命名空间缺失时 getOrThrow 抛错——启动即失败（fail-fast），
 * 不允许"没有密钥也把应用跑起来"的静默降级。
 */
export function buildJwtModuleOptions(
  configService: ConfigService,
): JwtModuleOptions {
  const jwt = configService.getOrThrow<JwtConfig>('jwt');
  return {
    secret: jwt.secret,
    signOptions: { expiresIn: jwt.accessTtlSeconds },
  };
}

/**
 * 认证模块：注册/登录/刷新/登出 + 用户数据模型。
 * JWT 密钥与有效期来自 jwt 配置命名空间（JWT_* 环境变量）；
 * access token 由 JwtModule 签发（expiresIn 用 accessTtlSeconds），
 * refresh token 由 AuthService 自行生成并落库。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User, RefreshToken]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: buildJwtModuleOptions,
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
