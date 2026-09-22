import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** 给用户分配角色（整体替换） */
export class AssignUserRolesDto {
  /** 角色 ID 列表；空数组 = 清空该用户全部角色（等同无角色） */
  @IsArray({ message: '角色必须是数组' })
  @IsString({ each: true, message: '角色 ID 必须是字符串' })
  roleIds: string[];
}

/** 用户分页查询 */
export class ListUsersQuery {
  /** 页码（从 1 开始） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '页码必须是整数' })
  @Min(1, { message: '页码不能小于 1' })
  page?: number;

  /** 每页条数（上限 100） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '每页条数必须是整数' })
  @Min(1, { message: '每页条数不能小于 1' })
  @Max(100, { message: '每页条数不能超过 100' })
  pageSize?: number;
}

/** 用户状态枚举（与 user.entity 的 CHECK 约束一致） */
export const USER_STATUSES = ['active', 'disabled', 'banned'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * 管理员代建用户：校验规则与注册（RegisterDto）**完全一致**——
 * 管理端创建的用户必须能正常登录，标识规范化（邮箱小写/手机去分隔符）
 * 与密码字节上限在 service 层共用同一套公共工具（common/utils/account.ts）。
 */
export class CreateUserDto {
  /** 登录用户名：3-50 位字母/数字/下划线；不可为 6-20 位纯数字（登录标识路由） */
  @IsString({ message: '用户名必须是字符串' })
  @Length(3, 50, { message: '用户名长度需在 3-50 之间' })
  @Matches(/^[a-zA-Z0-9_]+$/, { message: '用户名只能包含字母、数字、下划线' })
  @Matches(/^(?!\d{6,20}$)[a-zA-Z0-9_]+$/, {
    message: '用户名不能是 6-20 位纯数字（会被识别为手机号登录标识，无法登录）',
  })
  username!: string;

  /** 初始密码：8-72 字符且总字节数不超过 72（bcrypt 输入上限） */
  @IsString({ message: '密码必须是字符串' })
  @Length(8, 72, { message: '密码长度需在 8-72 之间' })
  password!: string;

  /** 邮箱（选填；登录标识之一，写入前自动小写） */
  @IsOptional()
  @IsString({ message: '邮箱必须是字符串' })
  @Matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: '邮箱格式不正确' })
  email?: string;

  /** 手机号（选填；6-20 位数字，允许国际区号前缀 +） */
  @IsOptional()
  @IsString({ message: '手机号必须是字符串' })
  @Matches(/^\+?[0-9]{6,20}$/, { message: '手机号格式不正确' })
  phone?: string;

  /** 昵称（选填） */
  @IsOptional()
  @IsString({ message: '昵称必须是字符串' })
  @Length(1, 50, { message: '昵称长度需在 1-50 之间' })
  nickname?: string;
}

/**
 * 更新用户资料（管理端）：只允许资料字段——
 * 登录标识（username/email/phone）修改依赖验证流程（后续阶段），
 * 状态修改走 UpdateUserStatusDto（独立权限点 user:disable）。
 */
export class UpdateUserDto {
  /** 昵称 */
  @IsOptional()
  @IsString({ message: '昵称必须是字符串' })
  @Length(1, 50, { message: '昵称长度需在 1-50 之间' })
  nickname?: string;

  /** 真实姓名（实名场景用） */
  @IsOptional()
  @IsString({ message: '真实姓名必须是字符串' })
  @Length(1, 50, { message: '真实姓名长度需在 1-50 之间' })
  realName?: string;

  /** 性别：male | female | other（与表 CHECK 约束一致） */
  @IsOptional()
  @IsEnum(['male', 'female', 'other'], {
    message: '性别只能是 male/female/other',
  })
  gender?: 'male' | 'female' | 'other';

  /** 出生日期（ISO 日期字符串） */
  @IsOptional()
  @IsDateString({}, { message: '出生日期格式不正确' })
  birthDate?: string;

  /** 头像 URL */
  @IsOptional()
  @IsString({ message: '头像 URL 必须是字符串' })
  @Length(0, 500, { message: '头像 URL 不能超过 500 字符' })
  avatarUrl?: string;

  /** 备注（运营/审核场景扩展字段，仅管理端可见） */
  @IsOptional()
  @IsString({ message: '备注必须是字符串' })
  @Length(0, 500, { message: '备注不能超过 500 字符' })
  remark?: string;
}

/** 修改用户状态（管理端）：active 恢复 / disabled 禁用 / banned 封禁 */
export class UpdateUserStatusDto {
  /** 目标状态；非 active 时服务层同时撤销该用户全部活跃 refresh token（会话终止） */
  @IsEnum(USER_STATUSES, { message: '状态只能是 active/disabled/banned' })
  status: UserStatus;
}
