import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { User } from '../auth/entities/user.entity';
import { CleanupModule } from '../cleanup/cleanup.module';
import { JobDefinition } from './entities/job-definition.entity';
import { JobRun } from './entities/job-run.entity';
import { JobController } from './jobs.controller';
import { JobService } from './jobs.service';

/**
 * 定时任务管理模块（若依式调度中心）。
 * 依赖：
 * - CleanupModule：动作码执行目标（cleanup:* 三个动作），其导出的
 *   CleanupService 注入 JobService.actionRunners；
 * - AuditModule：管理操作审计（job.create/update/status.update/run/delete 五类埋点），
 *   导出的 AuditService 注入 JobService；
 * - AuthModule：提供 JwtService（JwtAuthGuard 依赖）；
 * - forFeature([..., User])：RolesGuard 依赖 UserRepository（同 audit/users 模块惯例）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([JobDefinition, JobRun, User]),
    CleanupModule,
    AuditModule,
    AuthModule,
  ],
  controllers: [JobController],
  providers: [JobService],
})
export class JobsModule {}
