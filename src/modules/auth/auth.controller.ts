import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import type { SchemaObject } from '../../common/swagger/api-response.decorator';
import {
  ApiConflictResponse,
  ApiCreatedEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-response.decorator';
import type { AppConfig, JwtConfig } from '../../config/types';
import { AuthService, type SafeUser, type TokenPair } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { type AuthenticatedRequest, JwtAuthGuard } from './jwt-auth.guard';

/** refresh token 的 httpOnly Cookie 名（登录/刷新/登出三处共用同一常量） */
const REFRESH_COOKIE = 'refresh_token';

/** Swagger 文档：登录/刷新成功响应的 data 形状（令牌对） */
const TOKEN_PAIR_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    accessToken: {
      type: 'string',
      description: 'JWT 访问令牌（15 分钟，Authorization: Bearer 携带）',
      example:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiaWF0Ijox...',
    },
    refreshToken: {
      type: 'string',
      description: '刷新令牌明文（仅此一次返回；DB 只存 SHA-256 哈希）',
      example: '0f8fad5b-d9cb-469f-a165-70867728950e0f8fad5b-d9cb-469f-a165',
    },
  },
  required: ['accessToken', 'refreshToken'],
};

/** Swagger 文档：/me 成功响应的 data 形状（安全用户信息，不含密码哈希等敏感列） */
const SAFE_USER_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '用户 ID', example: '1' },
    username: {
      type: 'string',
      description: '登录用户名（大小写敏感）',
      example: 'alice',
    },
    email: {
      type: 'string',
      description: '邮箱（小写规范化存储）',
      example: 'alice@example.com',
    },
    phone: {
      type: 'string',
      nullable: true,
      description: '手机号（去分隔符存储）',
      example: '+8613800138000',
    },
    nickname: { type: 'string', nullable: true, description: '昵称' },
    realName: { type: 'string', nullable: true, description: '真实姓名' },
    gender: {
      type: 'string',
      nullable: true,
      description: '性别',
      example: 'male',
    },
    birthDate: {
      type: 'string',
      nullable: true,
      format: 'date',
      description: '出生日期',
    },
    avatarUrl: { type: 'string', nullable: true, description: '头像 URL' },
    emailVerifiedAt: {
      type: 'string',
      nullable: true,
      format: 'date-time',
      description: '邮箱验证时间',
    },
    phoneVerifiedAt: {
      type: 'string',
      nullable: true,
      format: 'date-time',
      description: '手机号验证时间',
    },
    status: { type: 'string', description: '账号状态', example: 'active' },
    roles: {
      type: 'array',
      items: { type: 'string' },
      description: '角色码列表（前端导航/角色展示用）',
      example: ['admin'],
    },
    permissions: {
      type: 'array',
      items: { type: 'string' },
      description: '权限码并集（前端按钮级控制用）；admin 返回全量权限码',
      example: ['user:read', 'user:delete'],
    },
    createdAt: { type: 'string', format: 'date-time', description: '创建时间' },
    updatedAt: { type: 'string', format: 'date-time', description: '更新时间' },
  },
};

/**
 * 认证接口（/api/auth/*）。
 * 令牌分发策略：access token 只进响应体（客户端放内存，短命）；
 * refresh token 写 httpOnly Cookie（JS 不可读，防 XSS 窃取）+ 响应体回传
 * （移动端/第三方客户端无 Cookie 机制，用 body 字段自行存储）。
 * 登录/注册/刷新走更严限速，防爆破。
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  /** 注册：201 + 空响应（不返回用户信息、不自动登录；用户资料由登录后 /me 获取） */
  @ApiCreatedEnvelope(
    '注册成功：201 + 空 data（不返回用户信息，/me 是唯一资料入口）',
  )
  @ApiConflictResponse()
  @Post('register')
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  register(@Body() dto: RegisterDto): Promise<void> {
    return this.authService.register(dto);
  }

  /** 登录：校验通过 → 令牌对；失败统一 401（防账号枚举） */
  @ApiOkEnvelope('登录成功，返回令牌对', TOKEN_PAIR_SCHEMA)
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPair> {
    const pair = await this.authService.login(
      dto,
      this.clientIp(req),
      req.headers['user-agent'] ?? '',
    );
    this.setRefreshCookie(res, pair.refreshToken);
    return pair;
  }

  /** 刷新：旧 refresh token 轮换为新对（Cookie 或 body 二选一） */
  @ApiOkEnvelope(
    '刷新成功，返回新令牌对（旧令牌已轮换撤销）',
    TOKEN_PAIR_SCHEMA,
  )
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPair> {
    const rawToken = this.resolveRefreshToken(dto, req);
    if (!rawToken) {
      // Cookie 与 body 均未携带：刷新必须有令牌（登出才允许无令牌幂等）
      throw new UnauthorizedException('缺少刷新令牌');
    }
    const pair = await this.authService.refresh(
      rawToken,
      this.clientIp(req),
      req.headers['user-agent'] ?? '',
    );
    this.setRefreshCookie(res, pair.refreshToken);
    return pair;
  }

  /** 登出：撤销当前 refresh token + 清 Cookie（幂等） */
  @ApiOkEnvelope('登出成功（幂等：重复登出/无令牌仍返回成功）', {
    type: 'object',
    properties: { loggedOut: { type: 'boolean', example: true } },
  })
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ loggedOut: boolean }> {
    await this.authService.logout(this.resolveRefreshToken(dto, req));
    this.clearRefreshCookie(res);
    return { loggedOut: true };
  }

  /** 当前用户（访问令牌示例：Bearer + JwtAuthGuard） */
  @ApiBearerAuth() // Swagger 文档的"Authorize"按钮：受保护端点统一从这里挂令牌
  @ApiOkEnvelope('当前用户信息（不含密码哈希等敏感字段）', SAFE_USER_SCHEMA)
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: AuthenticatedRequest): Promise<SafeUser> {
    return this.authService.me(req.user.id);
  }

  /**
   * 自助修改个人资料：只允许资料字段（昵称/性别/生日/头像）。
   * 登录标识（用户名/邮箱/手机号）不可自助修改——标识变更依赖验证流程
   * （后续阶段）；管理端改他人资料走 PATCH /api/users/:id（user:update）。
   */
  @ApiBearerAuth()
  @ApiOkEnvelope('更新成功，返回最新用户信息', SAFE_USER_SCHEMA)
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  updateMe(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateMeDto,
  ): Promise<SafeUser> {
    return this.authService.updateMe(req.user.id, dto);
  }

  /** refresh token 解析顺序：Cookie 优先，body 兜底（移动端无 Cookie） */
  private resolveRefreshToken(
    dto: RefreshDto,
    req: Request,
  ): string | undefined {
    const fromCookie = (req.cookies as Record<string, unknown> | undefined)?.[
      REFRESH_COOKIE
    ];
    // 空串 Cookie（浏览器可能发送 refresh_token=）不能视为有效令牌：
    // typeof 判断会把空串当"已携带"，导致合法 body 令牌被忽略（刷新被拒、登出静默失效）。
    // && 短路后空串（falsy）自然回退到 dto.refreshToken
    return fromCookie && typeof fromCookie === 'string'
      ? fromCookie
      : dto.refreshToken;
  }

  /**
   * 写 refresh token Cookie。path 覆盖整个认证前缀（/{API_PREFIX}/auth）而非仅刷新端点：
   * 若收窄到 /refresh，浏览器在请求 /logout 时不会携带 Cookie（Path 不匹配），
   * 登出将只清 Cookie 而服务端令牌仍然有效——登出必须能撤销服务端状态。
   * 宽到 /auth 前缀是"登出可用"与"最小暴露"的折中：仅 auth 域端点可见该 Cookie，
   * 服务端只在 refresh/logout 读取它。前缀从配置取，改 API_PREFIX 不失效。
   */
  private setRefreshCookie(res: Response, token: string): void {
    const jwt = this.configService.getOrThrow<JwtConfig>('jwt');
    const app = this.configService.getOrThrow<AppConfig>('app');
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      // 本地 http 调试不放 secure（浏览器会拒收）；生产 https 必须 Secure
      secure: app.env === 'production',
      sameSite: 'lax',
      path: `/${app.prefix}/auth`,
      maxAge: jwt.refreshTtlSeconds * 1000,
    });
  }

  private clearRefreshCookie(res: Response): void {
    const app = this.configService.getOrThrow<AppConfig>('app');
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      path: `/${app.prefix}/auth`,
    });
  }

  /**
   * 客户端 IP：直接取 req.ip——Express 已按 trust proxy 层数解析 X-Forwarded-For
   * （app.setup.ts 配置，直连部署 TRUST_PROXY=false 时忽略伪造的转发头）。
   * 不要在这里手工读原始 X-Forwarded-For：那会绕过 trust proxy 语义，
   * 让直连部署的日志 IP 与限速维度（throttler 用 req.ips/req.ip）可被伪造且不一致。
   */
  private clientIp(req: Request): string {
    return req.ip ?? '';
  }
}
