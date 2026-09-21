import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

/** 登录请求：账号（用户名/邮箱/手机号任一）+ 密码 */
export class LoginDto {
  /** 登录账号：用户名 / 邮箱 / 手机号任一 */
  @ApiProperty({
    description: '登录账号（用户名 / 邮箱 / 手机号任一）',
    example: 'alice',
  })
  @IsString({ message: '账号必须是字符串' })
  @Length(1, 255, { message: '账号不能为空' })
  account!: string;

  /**
   * 密码：仅校验非空字符串，不设长度上界——
   * 登录失败必须统一 401 + 恒时（防枚举），HTTP 层用 @Length 拒超长口令会
   * 提前抛 400、泄露处理路径差异；72 字节截断上限由服务层统一处理（超长
   * 先假比对再统一"账号或密码错误"）。注册 DTO 保留 @Length(8,72)（注册拒绝
   * 过长密码是明确的产品提示，不涉及防枚举）。
   */
  @ApiProperty({ description: '密码', example: 'secret123', writeOnly: true })
  @IsString({ message: '密码必须是字符串' })
  @IsNotEmpty({ message: '密码不能为空' })
  password!: string;
}
