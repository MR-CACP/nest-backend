import {
  Controller,
  Delete,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { PERMISSION_CODES } from '../../common/constants/rbac.constants';
import { Permissions } from '../../common/decorators/rbac.decorator';
import { SchemaObject } from '../../common/swagger/api-response.decorator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../rbac/roles.guard';
import { ListSessionsQuery } from './sessions.dto';
import { SessionListPage, SessionsService } from './sessions.service';

/** Swagger：在线会话单项 schema（不含 tokenHash 等敏感列） */
const SESSION_ITEM_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '会话 ID（refresh token 行 ID）' },
    userId: { type: 'string', description: '所属用户 ID' },
    username: { type: 'string', description: '用户名' },
    ip: { type: 'string', nullable: true, description: '登录 IP' },
    userAgent: { type: 'string', nullable: true, description: '登录设备 UA' },
    createdAt: { type: 'string', format: 'date-time', description: '登录时间' },
    expiresAt: { type: 'string', format: 'date-time', description: '过期时间' },
    revokedAt: {
      type: 'string',
      nullable: true,
      format: 'date-time',
      description: '撤销时间（在线列表恒为 null）',
    },
  },
};

/** Swagger：在线会话分页 schema */
const SESSION_PAGE_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    items: { type: 'array', items: SESSION_ITEM_SCHEMA },
    total: { type: 'number' },
    page: { type: 'number' },
    pageSize: { type: 'number' },
  },
};

/**
 * 会话管理端接口：在线列表 + 强制下线（单会话 / 全部）。
 * 说明：
 * - "在线" = refresh_tokens 活跃行（revoked_at IS NULL 且未过期）；
 * - 单会话下线只撤销该 refresh 行；全部下线撤销全部 + 递增 session_version
 *   （旧 access token 即时失效，见 jwt-auth.guard 的版本校验）；
 * - 权限点 session:read / session:revoke 在 PERMISSION_CODES（代码侧唯一真源），
 *   由迁移 InitSessionPermissions 种子登记；
 * - 管理端遵循 REST 语义（404），与认证端"HTTP 200 + 业务码"刻意区分。
 */
@ApiTags('会话管理')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  /** 在线会话分页列表（可按 userId / username 筛选） */
  @Get('sessions')
  @Permissions(PERMISSION_CODES.SESSION_READ)
  @ApiOkResponse({
    description: '在线会话分页列表',
    schema: SESSION_PAGE_SCHEMA,
  })
  @ApiQuery({ name: 'page', required: false, description: '页码（从 1 开始）' })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数（上限 100）',
  })
  @ApiQuery({ name: 'userId', required: false, description: '按用户 ID 筛选' })
  @ApiQuery({
    name: 'username',
    required: false,
    description: '按用户名筛选（**精确匹配**，不支持模糊）',
  })
  listSessions(@Query() query: ListSessionsQuery): Promise<SessionListPage> {
    return this.sessionsService.list(query);
  }

  /** 强制下线单个会话（撤销该 refresh 行；不存在/已下线 404） */
  @Delete('sessions/:id')
  @Permissions(PERMISSION_CODES.SESSION_REVOKE)
  @ApiOkResponse({
    description:
      '下线成功（仅终止该会话的刷新能力；该用户其他已签发 access 仍存活最长 15 分钟，即时掐断需用全部下线）',
  })
  @ApiParam({ name: 'id', description: '会话 ID' })
  revokeSession(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    // operatorId 用于降级防护：非 admin 不得下线管理员账号（与全部下线同口径）
    return this.sessionsService.revokeOne(id, req.user.id);
  }

  /** 强制下线某用户全部会话（撤销全部 + 递增版本号 → 旧 access 即时失效） */
  @Delete('users/:id/sessions')
  @Permissions(PERMISSION_CODES.SESSION_REVOKE)
  @ApiOkResponse({ description: '全部会话已下线' })
  @ApiParam({ name: 'id', description: '用户 ID' })
  revokeUserSessions(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    // operatorId 用于降级防护：非 admin 不得下线管理员账号（与 users 管理口径一致）
    return this.sessionsService.revokeAllByUser(id, req.user.id);
  }
}
