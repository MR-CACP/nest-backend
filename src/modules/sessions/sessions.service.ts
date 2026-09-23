import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';

import { AUDIT_ACTIONS } from '../../common/constants/audit.constants';
import { assertNoAdminDowngrade } from '../../common/utils/admin-guard';
import { AuditService } from '../audit/audit.service';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { User } from '../auth/entities/user.entity';
import type { ListSessionsQuery } from './sessions.dto';

/** 在线会话列表项（投影：显式挑字段，tokenHash 等敏感列绝不外泄） */
export interface SessionListItem {
  id: string;
  userId: string;
  username: string;
  ip: string | null;
  userAgent: string | null;
  /** 登录（签发）时间 */
  createdAt: Date;
  /** 会话过期时间（refresh 到期即下线） */
  expiresAt: Date;
  /** 撤销时间：NULL = 在线 */
  revokedAt: Date | null;
}

/** 在线会话分页页（与 users 列表同形：items + total + page + pageSize） */
export interface SessionListPage {
  items: SessionListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 会话管理：在线列表 + 强制下线（管理端）。
 * "在线"的定义：refresh_tokens 中 revoked_at IS NULL 且 expires_at > now 的行——
 * access token 是无状态 JWT，服务端不追踪；refresh token 是唯一可靠的会话载体
 * （登录时落库，刷新轮换，登出/下线写撤销时间）。
 * 强制下线的两段式语义：
 * - 撤销 refresh 行 → 该会话的刷新立即失效（最长 15 分钟 access 窗口，无状态 JWT 取舍）；
 * - 递增 session_version → 旧 access token 即时失效（guard 每请求比对版本号，
 *   见 jwt-auth.guard.ts 的会话版本校验）——"踢出"的完整语义是两者同时发生。
 */
@Injectable()
export class SessionsService {
  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    // 全部下线：撤销会话 + 递增版本号必须同事务（同生共死）
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  /**
   * 在线会话分页列表（可按 userId / username 筛选）。
   * username 筛选走 join（会话行只存 userId，不冗余用户名）；
   * 排序按登录时间倒序（最近的会话在前）。
   */
  async list(query: ListSessionsQuery): Promise<SessionListPage> {
    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 20, 100);
    const qb = this.refreshTokens
      .createQueryBuilder('rt')
      .innerJoin('rt.user', 'u')
      .where('rt.revoked_at IS NULL')
      .andWhere('rt.expires_at > :now', { now: new Date() });
    if (query.userId) {
      qb.andWhere('rt.user_id = :userId', { userId: query.userId });
    }
    if (query.username) {
      qb.andWhere('u.username = :username', { username: query.username });
    }
    const [rows, total] = await qb
      .select([
        'rt.id',
        'rt.userId',
        'u.username',
        'rt.ip',
        'rt.userAgent',
        'rt.createdAt',
        'rt.expiresAt',
        'rt.revokedAt',
      ])
      // (created_at, id) 双键排序：offset 翻页稳定（与 users 列表同款理由）
      .orderBy('rt.created_at', 'DESC')
      .addOrderBy('rt.id', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return {
      items: rows.map((rt) => ({
        id: rt.id,
        userId: rt.userId,
        // innerJoin 保证 user 存在（理论不可达兜底：select 部分加载只填充 username，
        // 若数据异常此处静默成空串而非 500——刻意选宽松投影，列表接口不因单行坏数据整页失败）
        username:
          (rt.user as { username?: string } | undefined)?.username ?? '',
        ip: rt.ip,
        userAgent: rt.userAgent,
        createdAt: rt.createdAt,
        expiresAt: rt.expiresAt,
        revokedAt: rt.revokedAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 强制下线单个会话：条件撤销（revoked_at IS NULL）——只撤销该会话的 refresh 行，
   * 不递增 session_version（"最小影响"取舍，**能力边界**）：被下线会话的刷新能力
   * 立即终止，但该用户**已签发的 access token 仍存活最长 15 分钟**（无状态 JWT 窗口，
   * 只有"全部下线"递增版本号才即时掐断 access）。操作者需知悉此语义（README 已标注）。
   * 已下线/不存在一律 404（REST 语义：目标不存在）。
   * @param operatorId 操作者 ID：降级防护（与 revokeAllByUser 同口径）——非 admin
   *                  不得逐个撤销管理员的新会话（否则"全部下线"防护被单会话入口绕过，
   *                  同一骚扰级 DoS）。先查会话所属用户 roles 再判定，随后 CAS 撤销
   *                  （并发撤销后到者 affected=0 → 404）
   */
  async revokeOne(
    id: string,
    operatorId: string,
    /** 操作者 IP（controller 透传 req.ip，落 audit_logs） */
    ip?: string,
  ): Promise<void> {
    const session = await this.refreshTokens.findOneBy({
      id,
      revokedAt: IsNull(),
    });
    if (!session) {
      throw new NotFoundException('会话不存在或已下线');
    }
    // target 与 operator 互不依赖：并行查（两次 findOne 可同时发出）。
    // 操作者不直接复用 JwtAuthGuard 预加载的 req.userEntity——与 users 模块同口径的
    // 防御设计：service 独立按 operatorId 查库，防请求上下文被篡改/身份漂移，
    // 且方法不依赖调用方传对对象（管理端低频，多 1 次往返可接受，注释为取舍记录）
    const [target, operator] = await Promise.all([
      this.users.findOne({
        where: { id: session.userId },
        relations: { userRoles: { role: true } },
      }),
      this.users.findOne({
        where: { id: operatorId },
        relations: { userRoles: { role: true } },
      }),
    ]);
    // target 为 null（孤儿会话/用户已删）：无用户可降级，放行撤销（清理异常数据）
    assertNoAdminDowngrade(target?.roles, operator, '无权下线管理员账号的会话');
    const revoked = await this.refreshTokens.update(
      { id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    if (revoked.affected !== 1) {
      throw new NotFoundException('会话不存在或已下线');
    }
    // 操作审计（尽力而为）
    await this.audit.record({
      operatorId,
      action: AUDIT_ACTIONS.SESSION_REVOKE,
      resourceType: 'session',
      resourceId: id,
      detail: { userId: session.userId },
      ip,
    });
  }

  /**
   * 强制下线某用户全部会话（"踢出"）：撤销全部活跃 refresh + 递增 session_version，
   * 同一事务（同生共死）——只递增不撤销会留下可刷新的会话，只撤销不递增会让旧 access
   * 存活最长 15 分钟；两者合起来才是即时踢出的完整语义。
   * 事务内先锁用户行（SELECT ... FOR UPDATE）：并发踢人/用户删除下版本号计算基于
   * 锁内读到的值，避免"递增被覆盖/用户已删仍写"的竞态。
   * 用户不存在 → 404。
   * @param operatorId 操作者 ID：降级防护（与 users.assignUserRoles / updateUserStatus
   *                  同一口径，见 common/utils/admin-guard.ts）——非 admin 操作者
   *                  不得下线持有 admin 角色的账号（防止反复踢管理员的骚扰级 DoS）
   */
  async revokeAllByUser(
    userId: string,
    operatorId: string,
    /** 操作者 IP（controller 透传 req.ip，落 audit_logs） */
    ip?: string,
  ): Promise<void> {
    // 降级判定用查库后的实时角色（与"每请求查库"模型一致，不复用令牌快照）；
    // 操作者同样独立查库，不复用 JwtAuthGuard 预加载的 req.userEntity——
    // 与 users 模块同口径的防御设计（防上下文篡改/身份漂移；管理端低频可接受）。
    // 目标含 roles：判定目标是否持 admin
    const target = await this.users.findOne({
      where: { id: userId },
      relations: { userRoles: { role: true } },
    });
    if (!target) {
      throw new NotFoundException('用户不存在');
    }
    const operator = await this.users.findOne({
      where: { id: operatorId },
      relations: { userRoles: { role: true } },
    });
    assertNoAdminDowngrade(target.roles, operator, '无权下线管理员账号的会话');
    await this.dataSource.transaction(async (manager) => {
      // 必须用 manager 的仓库：TypeORM 默认仓库绑定默认连接、不受事务保护
      // （与 auth.refresh 轮换 / users.updateUserStatus 同一陷阱）
      const user = await manager.getRepository(User).findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) {
        throw new NotFoundException('用户不存在');
      }
      await manager
        .getRepository(RefreshToken)
        .update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
      await manager
        .getRepository(User)
        .update({ id: userId }, { sessionVersion: user.sessionVersion + 1 });
    });
    // 并发安全：本事务与 auth.refresh 轮换都以"锁用户行（SELECT ... FOR UPDATE）"
    // 为前置，两者完全串行（auth.refresh 事务内锁行后重查状态/版本，见 auth.service）：
    // · 本事务先提交 → refresh 后锁行，其 CAS 撤销匹配不到已撤销的旧行 → 401；
    // · refresh 先提交 → 本事务的批量撤销会覆盖新插入的行 → 会话被彻底清除。
    // 无"批量撤销后新 refresh 行复活会话"的竞态窗口。
    // 操作审计（尽力而为）
    // 注意 resourceType 用 'user' 而非 'session'：resourceId 是**用户 ID**（不是会话 ID），
    // 用 'session' 会让"按 resourceType=session 检索"混入两种语义（会话 ID / 用户 ID）
    await this.audit.record({
      operatorId,
      action: AUDIT_ACTIONS.SESSION_REVOKE_ALL,
      resourceType: 'user',
      resourceId: userId,
      ip,
    });
  }
}
