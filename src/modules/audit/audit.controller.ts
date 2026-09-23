import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { PERMISSION_CODES } from '../../common/constants/rbac.constants';
import { Permissions } from '../../common/decorators/rbac.decorator';
import { SchemaObject } from '../../common/swagger/api-response.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../rbac/roles.guard';
import { ListAuditLogsQueryDto, ListLoginLogsQueryDto } from './audit.dto';
import { AuditLogPage, AuditService, LoginLogPage } from './audit.service';

/** Swagger：登录日志单项 schema */
const LOGIN_LOG_ITEM_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '日志 ID' },
    userId: {
      type: 'string',
      nullable: true,
      description: '关联用户 ID（失败且无用户时为空）',
    },
    account: {
      type: 'string',
      nullable: true,
      description: '登录账号（已脱敏，不落 PII 明文）',
    },
    success: { type: 'boolean', description: '是否成功' },
    failReason: {
      type: 'string',
      nullable: true,
      description: '失败原因（invalid_credentials / account_disabled）',
    },
    ip: {
      type: 'string',
      nullable: true,
      description: '登录 IP（已按 TRUST_PROXY 解析）',
    },
    userAgent: { type: 'string', nullable: true, description: '登录设备 UA' },
    createdAt: { type: 'string', format: 'date-time', description: '登录时间' },
  },
};

/** Swagger：操作审计单项 schema */
const AUDIT_LOG_ITEM_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '审计 ID' },
    operatorId: {
      type: 'string',
      nullable: true,
      description: '操作者用户 ID',
    },
    action: {
      type: 'string',
      description:
        '动作码（如 user.create / role.update / session.revoke_all）',
    },
    resourceType: {
      type: 'string',
      description: '资源类型（user / role / session；permission 永不产生）',
    },
    resourceId: { type: 'string', nullable: true, description: '资源 ID' },
    detail: {
      type: 'object',
      nullable: true,
      description: '变更摘要（不含敏感字段）',
    },
    ip: {
      type: 'string',
      nullable: true,
      description: '操作者 IP（controller 透传 req.ip 落库，可溯源）',
    },
    createdAt: { type: 'string', format: 'date-time', description: '操作时间' },
  },
};

/** Swagger：分页包装 schema */
function pageSchema(item: SchemaObject): SchemaObject {
  return {
    type: 'object',
    properties: {
      items: { type: 'array', items: item },
      total: { type: 'number' },
      page: { type: 'number' },
      pageSize: { type: 'number' },
    },
  };
}

/**
 * 审计管理端接口：登录日志 + 管理操作审计的分页查询（只读）。
 * 说明：
 * - 权限点 audit:read（PERMISSION_CODES，迁移 InitAuditPermissions 登记）；
 * - 登录日志 account 已脱敏、操作审计 detail 不含敏感字段——查询层无额外脱敏；
 * - 本模块只读不写：写入由 AuthService（登录）与 users/rbac/sessions 管理
 *   写路径经 AuditService 完成（写入尽力而为，失败不阻断主流程）。
 */
@ApiTags('审计')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /** 登录日志分页（可按成功/失败过滤，按时间倒序） */
  @Get('audit/login-logs')
  @Permissions(PERMISSION_CODES.AUDIT_READ)
  @ApiOkResponse({
    description: '登录日志分页（按时间倒序）',
    schema: pageSchema(LOGIN_LOG_ITEM_SCHEMA),
  })
  @ApiQuery({ name: 'page', required: false, description: '页码（从 1 开始）' })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数（上限 100）',
  })
  @ApiQuery({
    name: 'success',
    required: false,
    description: '按是否成功过滤（true/false）',
  })
  listLoginLogs(@Query() query: ListLoginLogsQueryDto): Promise<LoginLogPage> {
    return this.auditService.listLoginLogs(query);
  }

  /** 管理操作审计分页（可按动作码/操作者/资源类型过滤，按时间倒序） */
  @Get('audit/logs')
  @Permissions(PERMISSION_CODES.AUDIT_READ)
  @ApiOkResponse({
    description: '管理操作审计分页（按时间倒序）',
    schema: pageSchema(AUDIT_LOG_ITEM_SCHEMA),
  })
  @ApiQuery({ name: 'page', required: false, description: '页码（从 1 开始）' })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数（上限 100）',
  })
  @ApiQuery({
    name: 'action',
    required: false,
    description: '按动作码精确过滤（如 user.create）',
  })
  @ApiQuery({
    name: 'operatorId',
    required: false,
    description: '按操作者 ID 过滤',
  })
  @ApiQuery({
    name: 'resourceType',
    required: false,
    description: '按资源类型过滤（user/role/session）',
  })
  listLogs(@Query() query: ListAuditLogsQueryDto): Promise<AuditLogPage> {
    return this.auditService.listLogs(query);
  }
}
