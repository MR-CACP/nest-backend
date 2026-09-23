import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditLog } from '../audit/entities/audit-log.entity';
import { LoginLog } from '../audit/entities/login-log.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { JobRun } from '../jobs/entities/job-run.entity';
import { CleanupService } from './cleanup.service';

/**
 * 定时清理模块：跨模块复用四个实体的仓库（TypeORM forFeature 允许
 * 在多个模块注册同一实体），配合 jobs 模块的动态调度（动作码驱动，
 * 不再持有 @Cron 装饰器）。导出 CleanupService 供 JobsModule 注入
 * actionRunners（cleanup:* 动作的执行目标）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RefreshToken, LoginLog, AuditLog, JobRun]),
  ],
  providers: [CleanupService],
  exports: [CleanupService],
})
export class CleanupModule {}
