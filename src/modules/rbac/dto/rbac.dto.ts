import {
  IsArray,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

/** 角色 code 格式：小写字母开头 + 小写字母/数字/中划线（业务键，给 @Roles 引用） */
export const ROLE_CODE_PATTERN = /^[a-z][a-z0-9-]{0,49}$/;

/** 创建角色 */
export class CreateRoleDto {
  /** 角色业务码（如 editor）；小写字母开头，创建后不可修改 */
  @Matches(ROLE_CODE_PATTERN, {
    message: '角色 code 只能包含小写字母、数字和中划线，且以小写字母开头',
  })
  code: string;

  /** 角色展示名 */
  @IsString({ message: '角色名称必须是字符串' })
  @Length(1, 50, { message: '角色名称长度需在 1-50 个字符之间' })
  name: string;

  /** 角色说明（可选） */
  @IsOptional()
  @IsString({ message: '角色说明必须是字符串' })
  @Length(0, 255, { message: '角色说明不能超过 255 个字符' })
  description?: string;
}

/** 更新角色：只允许 name/description——code 是代码引用（@Roles），不可改 */
export class UpdateRoleDto {
  /** 角色展示名 */
  @IsString({ message: '角色名称必须是字符串' })
  @Length(1, 50, { message: '角色名称长度需在 1-50 个字符之间' })
  name: string;

  /** 角色说明（可选） */
  @IsOptional()
  @IsString({ message: '角色说明必须是字符串' })
  @Length(0, 255, { message: '角色说明不能超过 255 个字符' })
  description?: string;
}

/** 给角色分配权限（整体替换） */
export class AssignPermissionsDto {
  /** 权限点 ID 列表；空数组 = 清空该角色全部权限 */
  @IsArray({ message: '权限点必须是数组' })
  @IsString({ each: true, message: '权限点 ID 必须是字符串' })
  permissionIds: string[];
}
