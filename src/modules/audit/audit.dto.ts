import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * 登录日志分页查询：page/pageSize 分页 + 可选按成功/失败过滤。
 */
export class ListLoginLogsQueryDto {
  /** 页码（≥1；上界 1_000_000 防 (page-1)*pageSize 溢出 bigint 触发 PG 22003 → 500） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '页码必须是整数' })
  @Min(1, { message: '页码必须大于等于 1' })
  @Max(1_000_000, { message: '页码不能超过 1000000' })
  page?: number;

  /** 每页条数（1-100） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '每页条数必须是整数' })
  @Min(1, { message: '每页条数必须大于等于 1' })
  @Max(100, { message: '每页条数不能超过 100' })
  pageSize?: number;

  /** 按是否成功过滤（true/false，缺省不过滤） */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value as boolean | undefined;
  })
  @IsBoolean()
  success?: boolean;
}

/**
 * 管理操作审计分页查询：分页 + 可选按动作码 / 操作者 / 资源类型过滤。
 */
export class ListAuditLogsQueryDto {
  /** 页码（≥1；上界 1_000_000 防 (page-1)*pageSize 溢出 bigint 触发 PG 22003 → 500） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '页码必须是整数' })
  @Min(1, { message: '页码必须大于等于 1' })
  @Max(1_000_000, { message: '页码不能超过 1000000' })
  page?: number;

  /** 每页条数（1-100） */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: '每页条数必须是整数' })
  @Min(1, { message: '每页条数必须大于等于 1' })
  @Max(100, { message: '每页条数不能超过 100' })
  pageSize?: number;

  /** 按动作码过滤（等值匹配，如 user.create） */
  @IsOptional()
  @IsString()
  action?: string;

  /** 按操作者 ID 过滤 */
  @IsOptional()
  @IsString()
  operatorId?: string;

  /** 按资源类型过滤（实际只有 user / role / session 三种；permission 永不产生） */
  @IsOptional()
  @IsIn(['user', 'role', 'session'], {
    message: '资源类型只能是 user / role / session',
  })
  resourceType?: string;
}
