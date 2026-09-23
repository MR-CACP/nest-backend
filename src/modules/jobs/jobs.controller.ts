import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/rbac.decorator';
import {
  type AuthenticatedRequest,
  JwtAuthGuard,
} from '../auth/jwt-auth.guard';
import { RolesGuard } from '../rbac/roles.guard';
import {
  CreateJobDto,
  ListJobRunsQuery,
  ListJobsQuery,
  UpdateJobDto,
  UpdateJobStatusDto,
} from './dto/job.dto';
import { JobDefinition } from './entities/job-definition.entity';
import { JobRun } from './entities/job-run.entity';
import { JobService } from './jobs.service';

/**
 * 定时任务管理端接口（若依式调度中心）：任务定义 CRUD + 启停 + 手动执行 + 执行日志。
 * 全部走 JwtAuthGuard + RolesGuard + @Permissions（job:* 权限点）。
 */
@ApiTags('定时任务')
@ApiBearerAuth()
@Controller('jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class JobController {
  constructor(private readonly jobService: JobService) {}

  /** 任务定义分页列表 */
  @Get()
  @Permissions('job:read')
  @ApiOperation({ summary: '任务定义分页列表' })
  list(@Query() query: ListJobsQuery): Promise<{
    items: JobDefinition[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return this.jobService.list(query);
  }

  /** 创建任务（启用即热注册） */
  @Post()
  @Permissions('job:create')
  @ApiOperation({ summary: '创建定时任务（启用即注册调度）' })
  create(
    @Body() dto: CreateJobDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<JobDefinition> {
    // operatorId/ip 透传：管理操作审计（与 users/rbac/sessions 同款惯例）
    return this.jobService.create(dto, req.user.id, req.ip);
  }

  /** 部分更新任务（cron 变更热更新调度） */
  @Patch(':id')
  @Permissions('job:update')
  @ApiOperation({ summary: '更新定时任务（cron 变更热更新调度）' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateJobDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<JobDefinition> {
    return this.jobService.update(id, dto, req.user.id, req.ip);
  }

  /** 启停任务（状态变更立即生效） */
  @Patch(':id/status')
  @Permissions('job:update')
  @ApiOperation({ summary: '启停定时任务（立即生效）' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateJobStatusDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<JobDefinition> {
    return this.jobService.updateStatus(id, dto, req.user.id, req.ip);
  }

  /** 手动执行一次（跳过 cron 等待，返回本次执行结果） */
  @Post(':id/run')
  @HttpCode(200)
  @Permissions('job:run')
  @ApiOperation({ summary: '手动执行一次（立即运行，返回执行结果）' })
  run(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{
    jobId: string;
    name: string;
    status: 'success' | 'failed';
    durationMs: number;
    errorMessage: string | null;
  }> {
    return this.jobService.run(id, req.user.id, req.ip);
  }

  /** 删除任务（执行日志保留） */
  @Delete(':id')
  @Permissions('job:delete')
  @ApiOperation({ summary: '删除定时任务（执行日志保留）' })
  remove(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<void> {
    return this.jobService.remove(id, req.user.id, req.ip);
  }

  /** 指定任务的执行日志分页 */
  @Get(':id/runs')
  @Permissions('job:read')
  @ApiOperation({ summary: '任务执行日志分页' })
  listRuns(
    @Param('id') id: string,
    @Query() query: ListJobRunsQuery,
  ): Promise<{
    items: JobRun[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return this.jobService.listRuns(id, query);
  }
}
