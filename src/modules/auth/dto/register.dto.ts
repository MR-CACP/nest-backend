import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

/** 注册请求：用户名 + 密码必填；邮箱/手机号选填（登录标识三选一，用户名必填） */
export class RegisterDto {
  /** 登录用户名：3-50 位字母/数字/下划线。大小写敏感（Alice 与 alice 是两个账号）。
   *  不能是 6-20 位纯数字——登录按标识形态路由（auth.service.ts accountWhere），
   *  该区间的纯数字会被固定当作手机号查询，注册了也永远无法用用户名登录 */
  @ApiProperty({
    description:
      '登录用户名（字母/数字/下划线，大小写敏感；不可为 6-20 位纯数字）',
    example: 'alice',
    minLength: 3,
    maxLength: 50,
  })
  @IsString({ message: '用户名必须是字符串' })
  @Length(3, 50, { message: '用户名长度需在 3-50 之间' })
  @Matches(/^[a-zA-Z0-9_]+$/, { message: '用户名只能包含字母、数字、下划线' })
  @Matches(/^(?!\d{6,20}$)[a-zA-Z0-9_]+$/, {
    message: '用户名不能是 6-20 位纯数字（会被识别为手机号登录标识，无法登录）',
  })
  username!: string;

  /** 邮箱（选填；提供则必须格式合法，入库前统一小写） */
  @ApiProperty({
    description: '邮箱（选填；登录标识之一，写入前自动小写）',
    example: 'alice@example.com',
    required: false,
  })
  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不正确' })
  @Length(1, 255)
  email?: string;

  /** 手机号（选填；6-20 位数字，允许国际区号前缀 +，写入前去除空格/连字符） */
  @ApiProperty({
    description: '手机号（选填；登录标识之一，写入前自动去分隔符）',
    example: '+8613800138000',
    required: false,
  })
  @IsOptional()
  @Matches(/^\+?[0-9]{6,20}$/, { message: '手机号格式不正确' })
  phone?: string;

  /** 密码：8-72 个字符且总字节数不超过 72（bcrypt 输入上限，超出部分会被静默截断） */
  @ApiProperty({
    description: '密码（8-72 字符，总字节数不超过 72——bcrypt 输入上限）',
    example: 'secret123',
    minLength: 8,
    maxLength: 72,
    writeOnly: true,
  })
  @IsString({ message: '密码必须是字符串' })
  @Length(8, 72, { message: '密码长度需在 8-72 之间' })
  password!: string;
}
