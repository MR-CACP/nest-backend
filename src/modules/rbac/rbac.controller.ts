import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { PERMISSION_CODES } from '../../common/constants/rbac.constants';
import { Permissions } from '../../common/decorators/rbac.decorator';
import { SchemaObject } from '../../common/swagger/api-response.decorator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  AssignPermissionsDto,
  CreateRoleDto,
  UpdateRoleDto,
} from './dto/rbac.dto';
import { Permission } from './entities/permission.entity';
import { Role } from './entities/role.entity';
import { RbacService, RoleListItem } from './rbac.service';
import { RolesGuard } from './roles.guard';

/** 角色列表单项 Swagger schema（权限码数组） */
const ROLE_ITEM_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '角色 ID' },
    code: { type: 'string', description: '角色业务码（@Roles 引用）' },
    name: { type: 'string', description: '角色展示名' },
    description: { type: 'string', nullable: true },
    isSystem: { type: 'boolean', description: '系统内置（不可改删）' },
    permissions: {
      type: 'array',
      items: { type: 'string' },
      description: '绑定的权限码（admin 旁路拥有全部，不依赖此列表）',
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

/** 权限点单项 Swagger schema */
const PERMISSION_ITEM_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    code: { type: 'string', description: '权限码（user:read）' },
    name: { type: 'string' },
    group: { type: 'string', nullable: true, description: '权限分组' },
    description: { type: 'string', nullable: true },
  },
};

/**
 * RBAC 管理端接口：角色/权限管理（用户列表与角色分配见 UsersController）。
 * 说明：
 * - @Permissions 声明的权限码引用 PERMISSION_CODES 常量（代码侧唯一真源），
 *   对应权限点由迁移 InitRbacPermissions 种子登记；
 * - admin 角色由守卫硬编码旁路，天然拥有全部管理权限；
 * - 管理端遵循 REST 语义（404/403/409），与认证端"HTTP 200 + 业务码"刻意区分；
 * - 401/429 为通用契约（见 README「通用接口约定」），此处不重复声明。
 */
@ApiTags('RBAC 管理')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class RbacController {
  constructor(private readonly rbacService: RbacService) {}

  /** 角色列表（含权限码） */
  @Get('roles')
  @Permissions(PERMISSION_CODES.ROLE_READ)
  @ApiOkResponse({
    description: '角色列表',
    schema: { type: 'array', items: ROLE_ITEM_SCHEMA },
  })
  listRoles(): Promise<RoleListItem[]> {
    return this.rbacService.listRoles();
  }

  /** 创建角色（code 唯一，冲突 409） */
  @Post('roles')
  @Permissions(PERMISSION_CODES.ROLE_CREATE)
  @ApiCreatedResponse({ description: '创建成功', schema: ROLE_ITEM_SCHEMA })
  createRole(
    @Body() dto: CreateRoleDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Role> {
    return this.rbacService.createRole(dto, req.user.id, req.ip);
  }

  /** 更新角色（系统角色 403；code 不可改） */
  @Patch('roles/:id')
  @Permissions(PERMISSION_CODES.ROLE_UPDATE)
  @ApiOkResponse({ description: '更新成功', schema: ROLE_ITEM_SCHEMA })
  @ApiParam({ name: 'id', description: '角色 ID' })
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<Role> {
    return this.rbacService.updateRole(id, dto, req.user.id, req.ip);
  }

  /** 删除角色（系统角色 403；仍有关联用户 409） */
  @Delete('roles/:id')
  @Permissions(PERMISSION_CODES.ROLE_DELETE)
  @ApiOkResponse({ description: '删除成功' })
  @ApiParam({ name: 'id', description: '角色 ID' })
  deleteRole(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    return this.rbacService.deleteRole(id, req.user.id, req.ip);
  }

  /** 给角色分配权限（整体替换；系统角色 403） */
  @Put('roles/:id/permissions')
  @Permissions(PERMISSION_CODES.ROLE_ASSIGN_PERMISSION)
  @ApiOkResponse({ description: '分配成功' })
  @ApiParam({ name: 'id', description: '角色 ID' })
  assignRolePermissions(
    @Param('id') id: string,
    @Body() dto: AssignPermissionsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    // operatorId 用于提权防护：只能分配操作者自己拥有的权限（admin 旁路例外）
    return this.rbacService.assignRolePermissions(
      id,
      dto.permissionIds,
      req.user.id,
      req.ip,
    );
  }

  /** 权限点列表（只读，管理端权限树数据源） */
  @Get('permissions')
  @Permissions(PERMISSION_CODES.ROLE_READ)
  @ApiOkResponse({
    description: '权限点列表',
    schema: { type: 'array', items: PERMISSION_ITEM_SCHEMA },
  })
  listPermissions(): Promise<Permission[]> {
    return this.rbacService.listPermissions();
  }
}
