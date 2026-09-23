import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

import { JOB_ACTIONS } from '../../../common/constants/job.constants';

/** 创建任务定义：动作码必须是 JOB_ACTIONS 的 key（唯一真源） */
export class CreateJobDto {
  /** 任务名（唯一，页面展示） */
  @ApiProperty({
    description: '任务名（唯一）',
    example: 'cleanup-refresh-tokens',
  })
  @IsString()
  @Length(1, 100)
  name: string;

  /** 动作码：JOB_ACTIONS 常量清单的 key */
  @ApiProperty({
    description: '动作码（JOB_ACTIONS 常量清单）',
    example: 'cleanup:refresh-tokens',
    enum: Object.keys(JOB_ACTIONS),
  })
  @IsString()
  @IsIn(Object.keys(JOB_ACTIONS))
  actionCode: string;

  /** cron 表达式（cron 包 5/6 段格式；服务层校验合法性） */
  @ApiProperty({ description: 'cron 表达式（5/6 段）', example: '0 3 * * *' })
  @IsString()
  @Length(5, 100)
  cronExpression: string;

  /** 初始启停状态（默认启用） */
  @ApiPropertyOptional({ description: '启停状态', example: 'enabled' })
  @IsOptional()
  @IsIn(['enabled', 'disabled'])
  status?: 'enabled' | 'disabled';

  /** 备注（可选） */
  @ApiPropertyOptional({ description: '备注', example: '每日清理过期令牌' })
  @IsOptional()
  @IsString()
  @Length(0, 255)
  remark?: string;
}

/** 更新任务定义：全部可选（undefined 不覆盖，部分更新语义） */
export class UpdateJobDto {
  /** 任务名（唯一） */
  @ApiPropertyOptional({
    description: '任务名（唯一）',
    example: 'cleanup-refresh-tokens',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  /** 动作码 */
  @ApiPropertyOptional({
    description: '动作码',
    example: 'cleanup:refresh-tokens',
  })
  @IsOptional()
  @IsString()
  @IsIn(Object.keys(JOB_ACTIONS))
  actionCode?: string;

  /** cron 表达式（变更后热更新调度） */
  @ApiPropertyOptional({
    description: 'cron 表达式（5/6 段）',
    example: '0 3 * * *',
  })
  @IsOptional()
  @IsString()
  @Length(5, 100)
  cronExpression?: string;

  /** 备注 */
  @ApiPropertyOptional({ description: '备注', example: '每日清理过期令牌' })
  @IsOptional()
  @IsString()
  @Length(0, 255)
  remark?: string;
}

/** 启停状态变更（独立端点：与 update 分离，页面"启动/停用"按钮语义） */
export class UpdateJobStatusDto {
  /** 目标状态 */
  @ApiProperty({ description: '目标状态', example: 'disabled' })
  @IsIn(['enabled', 'disabled'])
  status: 'enabled' | 'disabled';
}

/** 任务列表查询（分页 + 状态筛选） */
export class ListJobsQuery {
  /** 页码（从 1 起） */
  @ApiPropertyOptional({ description: '页码（从 1 起）', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;

  /** 每页条数（上限 100，防拖库） */
  @ApiPropertyOptional({ description: '每页条数', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  /** 按启停状态筛选 */
  @ApiPropertyOptional({ description: '按启停状态筛选', example: 'enabled' })
  @IsOptional()
  @IsIn(['enabled', 'disabled'])
  status?: 'enabled' | 'disabled';
}

/** 执行日志查询（按任务 + 分页 + 结果筛选） */
export class ListJobRunsQuery {
  /** 页码（从 1 起） */
  @ApiPropertyOptional({ description: '页码（从 1 起）', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;

  /** 每页条数（上限 100，防拖库） */
  @ApiPropertyOptional({ description: '每页条数', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  /** 按执行结果筛选 */
  @ApiPropertyOptional({ description: '按执行结果筛选', example: 'success' })
  @IsOptional()
  @IsIn(['success', 'failed'])
  status?: 'success' | 'failed';
}
