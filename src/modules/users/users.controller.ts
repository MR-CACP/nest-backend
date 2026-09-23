import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
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
import {
  AssignUserRolesDto,
  CreateUserDto,
  ListUsersQuery,
  UpdateUserDto,
  UpdateUserStatusDto,
} from './users.dto';
import { AdminUser, UserListItem, UsersService } from './users.service';

/** 管理端用户单项 schema（完整资料；passwordHash 永不外泄） */
const ADMIN_USER_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    username: { type: 'string' },
    email: { type: 'string', nullable: true },
    phone: { type: 'string', nullable: true },
    nickname: { type: 'string', nullable: true },
    realName: { type: 'string', nullable: true },
    gender: { type: 'string', nullable: true },
    birthDate: { type: 'string', nullable: true, format: 'date' },
    avatarUrl: { type: 'string', nullable: true },
    status: { type: 'string', example: 'active' },
    remark: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

/** 用户列表分页 Swagger schema */
const USER_PAGE_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          username: { type: 'string' },
          email: { type: 'string', nullable: true },
          phone: { type: 'string', nullable: true },
          nickname: { type: 'string', nullable: true },
          status: { type: 'string' },
          roles: {
            type: 'array',
            items: { type: 'string' },
            description: '角色码',
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    total: { type: 'number' },
    page: { type: 'number' },
    pageSize: { type: 'number' },
  },
};

/**
 * 用户管理端接口：用户分页列表 + 角色分配（用户资源上的管理操作）。
 * 说明：
 * - 与 RBAC 分工：/api/users 归用户管理域（未来 CRUD/状态管理加在 UsersModule），
 *   rbac 只管 /roles、/permissions 与角色-权限绑定；
 * - 权限点 user:read / user:assign-role 在 PERMISSION_CODES（代码侧唯一真源），
 *   由迁移 InitRbacPermissions 种子登记；
 * - 管理端遵循 REST 语义（404/400），与认证端"HTTP 200 + 业务码"刻意区分；
 * - 401/429 为通用契约（见 README「通用接口约定」），此处不重复声明。
 */
@ApiTags('用户管理')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** 用户分页列表（含角色码） */
  @Get('users')
  @Permissions(PERMISSION_CODES.USER_READ)
  @ApiOkResponse({ description: '用户分页列表', schema: USER_PAGE_SCHEMA })
  @ApiQuery({ name: 'page', required: false, description: '页码（从 1 开始）' })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '每页条数（上限 100）',
  })
  listUsers(@Query() query: ListUsersQuery): Promise<{
    items: UserListItem[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return this.usersService.listUsers(query);
  }

  /** 创建用户（管理员代建；密码必填，规范化与注册一致） */
  @Post('users')
  @Permissions(PERMISSION_CODES.USER_CREATE)
  @ApiCreatedResponse({ description: '创建成功', schema: ADMIN_USER_SCHEMA })
  createUser(
    @Body() dto: CreateUserDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminUser> {
    return this.usersService.createUser(dto, req.user.id, req.ip);
  }

  /** 更新用户资料（不含登录标识与状态） */
  @Patch('users/:id')
  @Permissions(PERMISSION_CODES.USER_UPDATE)
  @ApiOkResponse({ description: '更新成功', schema: ADMIN_USER_SCHEMA })
  @ApiParam({ name: 'id', description: '用户 ID' })
  updateUser(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminUser> {
    return this.usersService.updateUser(id, dto, req.user.id, req.ip);
  }

  /** 修改用户状态（active/disabled/banned；非 active 即撤销该用户全部会话） */
  @Patch('users/:id/status')
  @Permissions(PERMISSION_CODES.USER_DISABLE)
  @ApiOkResponse({ description: '更新成功', schema: ADMIN_USER_SCHEMA })
  @ApiParam({ name: 'id', description: '用户 ID' })
  updateUserStatus(
    @Param('id') id: string,
    @Body() dto: UpdateUserStatusDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<AdminUser> {
    // operatorId 用于降级防护：非 admin 不得禁用/变更管理员账号
    return this.usersService.updateUserStatus(id, dto, req.user.id, req.ip);
  }

  /** 给用户分配角色（整体替换；空数组 = 清空） */
  @Put('users/:id/roles')
  @Permissions(PERMISSION_CODES.USER_ASSIGN_ROLE)
  @ApiOkResponse({ description: '分配成功' })
  @ApiParam({ name: 'id', description: '用户 ID' })
  assignUserRoles(
    @Param('id') id: string,
    @Body() dto: AssignUserRolesDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    // operatorId 用于提权防护：只能分配操作者自己拥有的角色（admin 旁路例外）
    return this.usersService.assignUserRoles(
      id,
      dto.roleIds,
      req.user.id,
      req.ip,
    );
  }
}
