import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

/**
 * 刷新/登出请求：refresh token 二选一传入——
 * 浏览器场景走 httpOnly Cookie（req.cookies.refresh_token，Path=/api/auth），
 * 移动端/第三方客户端无 Cookie 机制，用 body 的 refreshToken 字段。
 */
export class RefreshDto {
  /** 刷新令牌（明文；浏览器场景可省略，走 Cookie） */
  @ApiProperty({
    description: '刷新令牌（明文；浏览器场景可省略——Cookie 自动携带）',
    example: '0'.repeat(64),
    required: false,
  })
  @IsOptional()
  @IsString({ message: 'refreshToken 必须是字符串' })
  @Length(1, 128, { message: 'refreshToken 格式不正确' })
  refreshToken?: string;
}
