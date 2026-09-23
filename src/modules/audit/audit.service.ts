import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';

import { truncate } from '../../common/utils/account';
import { AuditLog } from './entities/audit-log.entity';
import { LoginLog } from './entities/login-log.entity';

/** 登录日志分页查询 */
export interface ListLoginLogsQuery {
  /** 页码（缺省 1；service 侧钳制下界，HTTP 侧由 DTO @Min/@Max 先校验） */
  page?: number;
  /** 每页条数（缺省 20，上限 100） */
  pageSize?: number;
  /** 按是否成功过滤（缺省不过滤） */
  success?: boolean;
}

/** 管理操作审计分页查询 */
export interface ListAuditLogsQuery {
  /** 页码（缺省 1；service 侧钳制下界，HTTP 侧由 DTO @Min/@Max 先校验） */
  page?: number;
  /** 每页条数（缺省 20，上限 100） */
  pageSize?: number;
  /** 按动作码过滤（等值匹配，如 user.create） */
  action?: string;
  /** 按操作者过滤 */
  operatorId?: string;
  /** 按资源类型过滤（user / role / session / job） */
  resourceType?: string;
}

/** 登录日志分页结果（单条 = 实体，不含敏感列——实体本身无敏感列） */
export interface LoginLogPage {
  items: LoginLog[];
  total: number;
  page: number;
  pageSize: number;
}

/** 管理操作审计分页结果 */
export interface AuditLogPage {
  items: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 审计服务：登录日志（login_logs）查询 + 管理操作审计（audit_logs）写入与查询。
 * 登录日志的**写入**在 AuthService.recordLoginLog（auth 模块自持 LoginLog 仓库，
 * 避免 AuthModule↔AuditModule 循环依赖）；本服务只负责 login_logs 的查询——
 * 曾在此重复实现 recordLogin（两份实现只测死代码），已删除，真实写入路径
 * 是 auth.service.ts 那份。
 *
 * 写入契约（record）：
 * - **尽力而为**：写入失败只记 warn，绝不抛出——管理操作已生效，
 *   审计是"追加的旁路"，失败不应让主流程变 500/回滚（README 已注明）；
 * - detail 只存变更摘要（状态 from→to、roleIds 等），禁止写入敏感字段
 *   （密码哈希、refresh 明文、完整请求体）——由调用方保证；
 * - ip 由 controller 从 req.ip 透传（已按 TRUST_PROXY 解析，非原始转发头）。
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(LoginLog)
    private readonly loginLogs: Repository<LoginLog>,
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
    private readonly logger: PinoLogger,
  ) {}

  /**
   * 管理操作审计写入（追加式；尽力而为：失败只记 warn、绝不抛出）。
   * 调用方**必须 await**：保证审计行在响应返回前已落库——事故排查时不会出现
   * "接口成功了但审计还没写"的窗口。这是"多一次 DB 往返延迟 vs 写入顺序保证"
   * 的有意取舍，勿随手改成 fire-and-forget（失败已吞，异步化看似无害，
   * 但会让审计与响应脱序）。
   */
  async record(input: {
    operatorId?: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    detail?: Record<string, unknown>;
    /** 操作者 IP（controller 从 req.ip 透传；缺省落 NULL） */
    ip?: string;
  }): Promise<void> {
    try {
      await this.auditLogs.save(
        this.auditLogs.create({
          operatorId: input.operatorId ?? null,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId ?? null,
          detail: input.detail ?? null,
          // 列宽 45 由写入方保证（truncate 与 auth 登录日志同一实现）：
          // req.ip 经 proxy-addr 校验天然有界，但 service 也可能被直接调用，
          // 兜底裁剪避免未来任意字符串路径触发 22001
          ip: truncate(input.ip, 45),
        }),
      );
    } catch (error) {
      this.logger.warn(
        { event: 'audit.recordFailed', action: input.action, error },
        '管理操作审计写入失败（已忽略，不影响主流程）',
      );
    }
  }

  /** 登录日志分页（按时间倒序） */
  async listLoginLogs(query: ListLoginLogsQuery): Promise<LoginLogPage> {
    // 钳制只覆盖**非 HTTP 调用路径**：HTTP 请求经 DTO @Min/@Max 先校验（400），
    // 到不了这里——直接调用 service（内部/测试）时它才是有效防线
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const [items, total] = await this.loginLogs.findAndCount({
      where: query.success === undefined ? {} : { success: query.success },
      // createdAt + id 双键稳定排序：同一时间戳多条记录时 offset 分页不重复/不遗漏
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }

  /** 管理操作审计分页（按时间倒序） */
  async listLogs(query: ListAuditLogsQuery): Promise<AuditLogPage> {
    // 同 listLoginLogs：钳制只覆盖非 HTTP 调用路径（HTTP 由 DTO 先 400）
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const [items, total] = await this.auditLogs.findAndCount({
      where: {
        ...(query.action ? { action: query.action } : {}),
        ...(query.operatorId ? { operatorId: query.operatorId } : {}),
        ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      },
      // 同 listLoginLogs：双键稳定排序
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }
}
