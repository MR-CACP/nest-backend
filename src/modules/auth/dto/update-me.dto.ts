import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

/**
 * 用户自助修改个人资料（PATCH /api/auth/me）：
 * 仅资料字段——昵称/性别/生日/头像；登录标识（用户名/邮箱/手机号）
 * 与状态不可自助修改（标识变更依赖验证流程，后续阶段）。
 */
export class UpdateMeDto {
  /** 昵称 */
  @ApiProperty({ description: '昵称', required: false, example: '爱丽丝' })
  @IsOptional()
  @IsString({ message: '昵称必须是字符串' })
  @Length(1, 50, { message: '昵称长度需在 1-50 之间' })
  nickname?: string;

  /** 性别：male | female | other */
  @ApiProperty({
    description: '性别',
    required: false,
    enum: ['male', 'female', 'other'],
  })
  @IsOptional()
  @IsEnum(['male', 'female', 'other'], {
    message: '性别只能是 male/female/other',
  })
  gender?: 'male' | 'female' | 'other';

  /** 出生日期（ISO 日期字符串） */
  @ApiProperty({
    description: '出生日期',
    required: false,
    example: '1995-06-01',
  })
  @IsOptional()
  @IsDateString({}, { message: '出生日期格式不正确' })
  birthDate?: string;

  /** 头像 URL */
  @ApiProperty({ description: '头像 URL', required: false })
  @IsOptional()
  @IsString({ message: '头像 URL 必须是字符串' })
  @Length(0, 500, { message: '头像 URL 不能超过 500 字符' })
  avatarUrl?: string;
}
