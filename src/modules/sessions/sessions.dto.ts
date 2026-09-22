import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** 在线会话分页查询：可按 userId / username 筛选（都为空 = 全部在线会话） */
export class ListSessionsQuery {
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

  /** 按用户 ID 筛选（非数字 ID 会打到 bigint → 400，全局过滤器兜底） */
  @IsOptional()
  @IsString({ message: '用户 ID 必须是字符串' })
  userId?: string;

  /** 按用户名筛选（精确匹配；会话行只存 userId，筛选走 join users） */
  @IsOptional()
  @IsString({ message: '用户名必须是字符串' })
  username?: string;
}
