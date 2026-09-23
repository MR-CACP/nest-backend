import { createHash, randomBytes } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { compare } from 'bcrypt';
import { PinoLogger } from 'nestjs-pino';
import {
  DataSource,
  EntityManager,
  FindOptionsWhere,
  IsNull,
  LessThan,
  Repository,
} from 'typeorm';

import { ADMIN_ROLE_CODE } from '../../common/constants/rbac.constants';
import { BusinessException } from '../../common/exceptions/business.exception';
import {
  assertPasswordByteLength,
  hashPassword,
  isUniqueViolation,
  maskAccount,
  normalizeEmail,
  normalizePhone,
  truncate,
} from '../../common/utils/account';
import type { JwtConfig } from '../../config/types';
import { LoginLog } from '../audit/entities/login-log.entity';
import { Permission } from '../rbac/entities/permission.entity';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import type { UpdateMeDto } from './dto/update-me.dto';
import { RefreshToken } from './entities/refresh-token.entity';
import { User } from './entities/user.entity';

/**
 * 固定哑哈希：**真实存在的 bcrypt("password") 哈希**（cost 10，$2b$ 前缀）。
 * 用途仅一个：账号不存在/无密码哈希（第三方账号）时对固定值执行 compare，
 * 让"账号不存在"与"密码错误"的响应时长一致（bcrypt 约 50-100ms，直接短路
 * 会留下可被统计的时长差，成为账号枚举通道）。
 * ⚠ 它绝不能充当有效凭证：登录判定里对无密码账号必须显式拒绝（!user.passwordHash），
 * 否则"compare 对哑哈希成功"会让固定口令 "password" 登录任何 passwordHash 为 NULL 的账号。
 */
const DUMMY_PASSWORD_HASH =
  '$2b$10$PAUM59cE7O7VnsBCWqv1KetzS0sppzoh93j3NnS7WqEe9M11PHMyi';

/** 业务码：账号已被禁用（HTTP 200 + X-Business-Code，见 business.exception.ts 契约） */
const ACCOUNT_DISABLED_BIZ_CODE = 10001;

/** 对外暴露的用户信息：显式挑字段，杜绝密码哈希等敏感列随序列化外泄 */
export type SafeUser = Pick<
  User,
  | 'id'
  | 'username'
  | 'email'
  | 'phone'
  | 'nickname'
  | 'realName'
  | 'gender'
  | 'birthDate'
  | 'avatarUrl'
  | 'emailVerifiedAt'
  | 'phoneVerifiedAt'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
> & {
  /** 角色码列表（前端导航/角色展示用；来自 user_roles 关系） */
  roles: string[];
  /** 权限码并集（去重，前端按钮级控制用）；admin 角色返回全量权限码（旁路） */
  permissions: string[];
};

/**
 * 登录/刷新成功后的令牌对。
 * 刻意不含用户信息：客户端需要用户资料时统一走 /me（数据始终最新），
 * 登录/刷新响应只负责令牌交接——少一个"响应体缓存过时用户信息"的坑。
 */
export interface TokenPair {
  /** JWT 访问令牌（15 分钟，Authorization: Bearer 携带） */
  accessToken: string;
  /** 刷新令牌明文（仅此一次返回；DB 只存 SHA-256 哈希） */
  refreshToken: string;
}

/**
 * 认证核心逻辑：注册 / 登录 / 刷新（轮换）/ 登出 / 当前用户。
 * 安全契约：
 * - 密码用 bcrypt 哈希（cost 10），比对恒定时长（账号不存在时用哑哈希假比对），
 *   登录失败统一"账号或密码错误"防枚举；
 * - refresh token 明文仅在响应出现一次，DB 存哈希，撤销/过期即失效，刷新即轮换（防重放）；
 *   刷新链路同样校验用户状态——被封禁账号不能通过刷新无限续期；
 * - 登录/注册事件写结构化 pino 日志（IP/UA 脱敏，账号字段不落 PII 明文）；
 * - access token 无状态不存库，短 TTL 缩小泄露窗口。
 */
@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokens: Repository<RefreshToken>,
    // RBAC：/me 的 admin 全量权限码查询（表小，见 toSafeUserWithRbac）
    @InjectRepository(Permission)
    private readonly permissions: Repository<Permission>,
    // 登录日志：实体注册在 AuditModule 的 forFeature（实体全局注册），
    // 这里就近持有仓库写入——避免 AuthModule → AuditModule 循环依赖
    @InjectRepository(LoginLog)
    private readonly loginLogs: Repository<LoginLog>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly logger: PinoLogger,
    // 事务入口：refresh 轮换的"撤销旧令牌 + 落库新令牌"必须原子（见 refresh）
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 注册：唯一性校验通过后写入新用户（status 默认 active）。
   * @param dto 注册请求（用户名 + 密码必填；邮箱/手机号选填，写入前规范化）
   * @returns 无返回（201 + 空 data）；用户资料由登录后 /me 获取，注册响应不承载用户信息
   */
  async register(dto: RegisterDto): Promise<void> {
    assertPasswordByteLength(dto.password);
    await this.ensureAccountAvailable(dto);
    const passwordHash = await hashPassword(dto.password);
    const user = await this.saveUserSafely({
      username: dto.username,
      // 规范化：邮箱小写、手机号去分隔符——PG varchar 大小写敏感，
      // 不规范化会出现 Alice@x.com 与 alice@x.com 两个账号
      email: normalizeEmail(dto.email),
      phone: normalizePhone(dto.phone),
      passwordHash,
    });
    this.logger.info({ event: 'auth.register', userId: user.id }, '用户注册');
  }

  /**
   * 登录：账号（用户名/邮箱/手机号任一）+ 密码 → 令牌对 + 用户信息。
   * 失败统一消息（账号不存在/密码错误不区分），防账号枚举；
   * 账号被禁用返回业务码（HTTP 200 + X-Business-Code），前端可据此区分交互。
   * @param dto 登录请求（account 可为用户名/邮箱/手机号）
   * @param ip 客户端 IP（已按 TRUST_PROXY 解析）
   * @param userAgent 客户端 UA（截断 255 后入库）
   * @returns 令牌对 + 安全用户信息
   */
  async login(
    dto: LoginDto,
    ip: string,
    userAgent: string,
  ): Promise<TokenPair> {
    // 按标识形态路由到单字段查询（见 accountWhere）——避免 OR 跨命名空间匹配：
    // 若某标识同时是 A 的用户名与 B 的手机号（仅并发竞态/直写 DB 才可能产生），
    // OR 查询会命中两行、findOne 返回不可预期，令牌可能绑到非预期账号
    const user = await this.users.findOne({
      where: this.accountWhere(dto.account),
    });
    // 超长口令（>72 字节，bcrypt 截断上限）不在这里抛 400：登录失败必须统一 401 +
    // 恒时（防枚举），快速 400 会泄露处理路径差异。先对真实/哑哈希执行一次假比对
    // 保持恒时，再统一走"账号或密码错误"。
    if (Buffer.byteLength(dto.password, 'utf8') > 72) {
      await compare(dto.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
      throw new UnauthorizedException('账号或密码错误');
    }
    // 恒时比对：账号不存在/无密码哈希（第三方账号）时对固定哑哈希执行 compare，
    // 消除"账号是否存在"的响应时长差（bcrypt 约 50-100ms，可被统计区分）
    const hashToCompare = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordOk = await compare(dto.password, hashToCompare);
    // 关键：!user.passwordHash 显式拒绝无密码账号（第三方登录/未设密通道预留）——
    // 若只判 !user || !passwordOk，口令恰好是 DUMMY 的明文 "password" 时 compare 成功，
    // 无密码账号会被固定口令放行（compare 对哑哈希 true，见 DUMMY_PASSWORD_HASH ⚠）。
    if (!user || !user.passwordHash || !passwordOk) {
      this.logger.warn(
        {
          event: 'auth.login.failed',
          account: maskAccount(dto.account),
          ip,
          userAgent,
        },
        '登录失败：账号或密码错误',
      );
      // 登录日志（尽力而为：写失败不影响 401 语义）
      // userId：账号存在（密码错/无密码哈希）时关联用户；账号不存在时为 null
      await this.recordLoginLog({
        userId: user?.id,
        account: dto.account,
        success: false,
        failReason: 'invalid_credentials',
        ip,
        userAgent,
      });
      throw new UnauthorizedException('账号或密码错误');
    }
    if (user.status !== 'active') {
      this.logger.warn(
        {
          event: 'auth.login.failed',
          userId: user.id,
          status: user.status,
          ip,
        },
        '登录被拒绝：账号未激活',
      );
      // 登录日志（尽力而为）
      await this.recordLoginLog({
        userId: user.id,
        account: dto.account,
        success: false,
        failReason: 'account_disabled',
        ip,
        userAgent,
      });
      // 业务结果而非框架故障：走业务码契约（HTTP 200 + bizCode），
      // 前端可区分"凭据错误(401)"与"账号被禁(bizCode)"
      throw new BusinessException('账号已被禁用', ACCOUNT_DISABLED_BIZ_CODE);
    }

    const tokens = await this.issueTokenPair(
      undefined,
      user.id,
      ip,
      userAgent,
      user.sessionVersion,
    );
    // 登录日志（尽力而为：写失败不影响已签发的令牌对）
    await this.recordLoginLog({
      userId: user.id,
      account: dto.account,
      success: true,
      ip,
      userAgent,
    });
    // 惰性清理：登录成功后删除该用户全部已过期行——revoked_at IS NULL 且已过期的行
    // 不再算在线（在线判定已排除）；已撤销但未过期的行保留（"已轮换令牌再次出现"的
    // 盗用检测依赖撤销记录）。只按过期收敛，不删未过期的撤销行，自然遏制 refresh_tokens
    // 的只增不清（无界增长）。
    // **尽力而为**：清理失败只记 warn 不阻断登录——令牌已签发、refresh 行已落库，
    // 登录语义已完整；DELETE 抛错直接传播会让客户端收到 500 并重试登录，产生第二个会话
    try {
      await this.refreshTokens.delete({
        userId: user.id,
        expiresAt: LessThan(new Date()),
      });
    } catch (error) {
      this.logger.warn(
        { event: 'auth.login.cleanupFailed', userId: user.id, error },
        '登录成功但惰性清理失败（过期 refresh 行暂未收敛）',
      );
    }
    this.logger.info(
      { event: 'auth.login.success', userId: user.id, ip, userAgent },
      '用户登录成功',
    );
    // 刻意不返回 user：客户端统一走 /me 取最新资料（见 TokenPair 注释）
    return tokens;
  }

  /**
   * 刷新令牌对（轮换）：旧 refresh token 立即撤销并签发新对。
   * 已撤销/已过期令牌一律 401——已被使用过的令牌再次出现视为重放风险。
   * 轮换是单个事务里的 CAS：撤销条件带 revokedAt IS NULL 且要求 affected===1，
   * 并发共用同一令牌时只有先撤销成功者能续期，后到者 401（README"后到者必然 401"成立）；
   * "撤销 + 落库新令牌"原子提交——落库失败整体回滚，旧令牌保持有效可重试，不会出现
   * "旧令牌已撤销、新令牌未落库"导致被迫重登的窗口。
   * 注意执行顺序：事务内**先锁用户行**（SELECT ... FOR UPDATE）并校验状态，再撤销/签发——
   * 令牌落库前失败不会留下 revoked_at IS NULL 的孤儿会话；被封禁账号也无法通过刷新续期；
   * 锁用户行同时与 revokeAllByUser（全部下线）完全串行（见事务内注释），
   * 消除"批量撤销提交后新 refresh 行复活会话"的并发竞态。
   * @param rawToken 明文 refresh token（浏览器走 Cookie，移动端走 body）
   * @param ip 客户端 IP
   * @param userAgent 客户端 UA
   * @returns 新令牌对 + 安全用户信息
   */
  async refresh(
    rawToken: string,
    ip: string,
    userAgent: string,
  ): Promise<TokenPair> {
    const token = await this.findActiveRefreshToken(rawToken);
    if (!token) {
      throw new UnauthorizedException('刷新令牌无效或已过期');
    }
    // 轮换 = 单个事务里的 compare-and-swap：
    // ① **先锁用户行**（SELECT ... FOR UPDATE）：与 revokeAllByUser（全部下线，同样
    //    锁用户行）完全串行——消除并发竞态。若不做此锁，全部下线事务"批量撤销 + 版本+1"
    //    提交后，本事务可能已通过前置检查并 CAS 撤销旧行，落库的新 refresh 行不在
    //    批量撤销范围内（INSERT 发生在撤销之后），于是会话复活：新行可再次刷新、
    //    用新版本签发完整令牌对（旧 access 401 但可再续期一次，"踢出"被绕过）。
    //    锁后两种交错都收敛：
    //    · refresh 先提交 → revokeAll 的批量撤销会覆盖新插入的行 → 会话被彻底清除；
    //    · revokeAll 先提交 → 旧令牌已被撤销，CAS affected=0 → 401。
    // ② 锁内重查用户：软删（deleted_at IS NULL 默认过滤）→ null → 401；非 active →
    //    业务 10001；**sessionVersion 必须取锁后最新值**（revokeAll 可能已递增，
    //    用旧值签发会让新 access 版本失配 401——正确性依赖锁内快照）。
    // ③ CAS 撤销：条件带 revokedAt IS NULL 且必须恰好影响 1 行——并发请求共用同一
    //    refresh token 时，只有先撤销成功者能续期，后到者 affected=0 → 401；
    //    "撤销旧令牌 + 落库新令牌"同生共死：落库失败整体回滚，旧令牌保持有效可重试。
    //    ⚠ 事务内的所有读写都必须走 manager：this.refreshTokens 绑定默认连接，
    //    在事务回调里用它执行 UPDATE 会在独立连接上立即提交、不受回滚保护，
    //    原子性形同虚设——撤销必须经 manager.getRepository 执行。
    // 已轮换令牌再次出现即"可能被盗用"信号，后续盗用检测（撤销该用户全部会话）可挂在这里。
    const tokens = await this.dataSource.transaction(async (manager) => {
      const lockedUser = await manager
        .getRepository(User)
        .createQueryBuilder('u')
        .setLock('pessimistic_write')
        .where('u.id = :id', { id: token.userId })
        .getOne();
      if (!lockedUser) {
        throw new UnauthorizedException('用户不存在');
      }
      if (lockedUser.status !== 'active') {
        throw new BusinessException('账号已被禁用', ACCOUNT_DISABLED_BIZ_CODE);
      }
      const revoked = await manager
        .getRepository(RefreshToken)
        .update(
          { id: token.id, revokedAt: IsNull() },
          { revokedAt: new Date() },
        );
      if (revoked.affected !== 1) {
        throw new UnauthorizedException('刷新令牌无效或已过期');
      }
      return this.issueTokenPair(
        manager,
        token.userId,
        ip,
        userAgent,
        lockedUser.sessionVersion,
      );
    });
    // 同上：令牌对不含用户信息，/me 是唯一用户资料入口
    return tokens;
  }

  /**
   * 登出：撤销当前 refresh token（幂等——找不到/已撤销也返回成功，
   * 重复登出、已过期令牌不视为错误）。
   * 撤销条件带 revokedAt IS NULL：已撤销的令牌不再次更新——否则重复登出会把
   * 首次撤销时间往后刷（审计时间被重写，与 users 软删行的同类问题，见
   * user.entity.ts 设计要点⚠）；幂等语义不变，首次撤销时刻得以保留。
   * @param rawToken 明文 refresh token；无令牌（如仅清 Cookie）时直接返回
   */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return; // 无令牌可撤销（如仅清 Cookie）
    const tokenHash = this.hashToken(rawToken);
    await this.refreshTokens.update(
      { tokenHash, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  /**
   * 当前用户信息（访问令牌已由守卫校验，这里按 userId 查库取最新数据）。
   * @param userId 访问令牌载荷中的用户 ID
   * @returns 安全用户信息；用户已被删除时 401
   */
  async me(userId: string): Promise<SafeUser> {
    const user = await this.users.findOne({
      where: { id: userId },
      // 角色 + 角色权限一起加载，组装 /me 的 roles/permissions
      relations: {
        userRoles: { role: { rolePermissions: { permission: true } } },
      },
    });
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }
    return this.toSafeUserWithRbac(user);
  }

  /**
   * 自助修改个人资料：只落传入字段（undefined 不覆盖），返回最新用户信息。
   * 不允许改登录标识与状态（DTO 已限定字段）。
   * @param userId 当前用户 ID（访问令牌载荷）
   * @param dto 资料字段（全可选）
   * @returns 更新后的安全用户信息
   */
  async updateMe(userId: string, dto: UpdateMeDto): Promise<SafeUser> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }
    Object.assign(user, {
      nickname: dto.nickname,
      gender: dto.gender,
      birthDate: dto.birthDate,
      avatarUrl: dto.avatarUrl,
    });
    const saved = await this.users.save(user);
    // 重查 roles/permissions（save 返回不带关系）：与 /me 同一组装路径
    return this.me(saved.id);
  }

  /**
   * 登录标识 → 单字段查询条件。按形态路由：含 @ → 邮箱；纯数字/+ 区号（6-20 位）
   * → 手机号；否则 → 用户名。每个 account 只匹配一个命名空间：
   * - 消除 OR 跨字段歧义（见 login 注释）；
   * - 邮箱/手机号复用规范化函数，与存储侧对称（trim + 小写 / 去分隔符），
   *   修复"登录查询只小写不 trim，带空格输入匹配不到已规范化的存储值"的缺陷；
   *   手机号形态判定基于**规范化后**的值（先 normalizePhone 再去空格/连字符），
   *   否则 '+86 138-0013-8000' 这类合法输入会因含分隔符落进 username 分支。
   * 已知取舍：6-20 位纯数字的用户名会被路由到手机号查询（username 正则允许纯数字，
   * 但作为登录标识时形态判定优先）——注册时建议避免纯数字用户名。
   */
  private accountWhere(account: string): FindOptionsWhere<User> {
    if (account.includes('@')) {
      return { email: normalizeEmail(account) ?? undefined };
    }
    const phone = normalizePhone(account);
    if (phone && /^\+?\d{6,20}$/.test(phone)) {
      return { phone };
    }
    return { username: account };
  }

  /**
   * 账号可用性：用户名必填唯一；邮箱/手机号提供则必须唯一。
   * 软删行（deletedAt 非空）视为可复用——注销后的标识允许重新注册；
   * 并发注册/软删竞态由 saveUserSafely 的 23505 兜底映射为 409。
   */
  private async ensureAccountAvailable(dto: RegisterDto): Promise<void> {
    const conflict = await this.users.findOne({
      withDeleted: true, // 包含软删行，否则唯一索引上的软删行会绕过应用层检查
      where: [
        { username: dto.username },
        ...(dto.email
          ? [{ email: normalizeEmail(dto.email) ?? undefined }]
          : []),
        ...(dto.phone
          ? [{ phone: normalizePhone(dto.phone) ?? undefined }]
          : []),
      ],
    });
    if (conflict && conflict.deletedAt === null) {
      // 不区分具体冲突字段：避免注册时枚举已存在账号
      throw new ConflictException('用户名、邮箱或手机号已被占用');
    }
  }

  /** 写库：唯一索引冲突（并发注册 / 软删竞态）映射为 409，而非 500 */
  private async saveUserSafely(input: Partial<User>): Promise<User> {
    try {
      return await this.users.save(this.users.create(input));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('用户名、邮箱或手机号已被占用');
      }
      throw err;
    }
  }

  /**
   * 记录登录日志（尽力而为）：登录成功/失败已返回客户端，日志写失败只记 warn，
   * 绝不抛出——否则"令牌已签发、日志 INSERT 失败"会让客户端收到 500 并重试登录
   * （与登录惰性清理同口径）。
   * 关键：**写入前按列宽裁剪**——UA/account 截断 255、ip 截断 45。若不裁剪，
   * 客户端发一个 >255 字符的 UA 会让 INSERT 抛 22001（value too long），被
   * 尽力而为吞掉后该次登录**完全不留痕**——对以追溯爆破为目的的登录审计是
   * 功能被绕过（login-log 实体注释里的"截断 255"必须由这里变成真代码）。
   * account 在本方法内脱敏（maskAccount）后入库，不落 PII 明文。
   */
  private async recordLoginLog(input: {
    userId?: string;
    account: string;
    success: boolean;
    failReason?: 'invalid_credentials' | 'account_disabled';
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    try {
      await this.loginLogs.save(
        this.loginLogs.create({
          userId: input.userId ?? null,
          account: truncate(maskAccount(input.account), 255),
          success: input.success,
          failReason: input.failReason ?? null,
          ip: truncate(input.ip, 45),
          userAgent: truncate(input.userAgent, 255),
        }),
      );
    } catch (error) {
      this.logger.warn(
        { event: 'auth.loginLogFailed', error },
        '登录日志写入失败（已忽略，不影响登录主流程）',
      );
    }
  }

  /**
   * 签发访问令牌 + 刷新令牌（刷新令牌落库，返回明文）。
   * access token 载荷 = { sub, sessionVersion }：
   * 强制下线（SessionsService.revokeAllByUser）递增 session_version 后，
   * JwtAuthGuard 每请求比对版本号——旧 access 即时失效（"踢出"不依赖 15 分钟窗口）。
   * @param manager 可选事务管理器：refresh 轮换在事务内调用（撤销+落库原子）；
   *                登录无撤销操作，不传（走默认仓库）。
   * @param sessionVersion 用户当前会话版本号（users.session_version；登录/刷新时查库取最新值）
   */
  private async issueTokenPair(
    manager: EntityManager | undefined,
    userId: string,
    ip: string,
    userAgent: string,
    sessionVersion: number,
  ): Promise<Omit<TokenPair, 'user'>> {
    const jwt = this.configService.getOrThrow<JwtConfig>('jwt');
    const accessToken = await this.jwtService.signAsync({
      sub: userId,
      sessionVersion,
    });
    const refreshToken = randomBytes(32).toString('hex'); // 64 字符明文
    const repo = manager?.getRepository(RefreshToken) ?? this.refreshTokens;
    await repo.save(
      repo.create({
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + jwt.refreshTtlSeconds * 1000),
        // ip 列 varchar(45)：超长（异常代理链）会让 PG 报 22001 → 500，写库前截断。
        // 参数已保证非空 string（controller 层 ?? ''）；'' 转 null（两列本就 nullable，
        // 空串占位既无信息量也会让"是否有 UA/IP"的查询语义失真）
        ip: truncate(ip, 45),
        userAgent: truncate(userAgent, 255),
      }),
    );
    return { accessToken, refreshToken };
  }

  /** 按哈希查活跃（未撤销、未过期）refresh token */
  private async findActiveRefreshToken(
    rawToken: string,
  ): Promise<RefreshToken | null> {
    const token = await this.refreshTokens.findOneBy({
      tokenHash: this.hashToken(rawToken),
    });
    if (!token) return null;
    if (token.revokedAt !== null) return null;
    if (token.expiresAt.getTime() <= Date.now()) return null;
    return token;
  }

  /** SHA-256 十六进制（64 字符，与 token_hash 列长度一致） */
  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * 组装 /me 响应：基础字段 + RBAC 角色/权限。
   * admin 旁路时返回全量权限码（permissions 表只有几十行，代价可忽略）——
   * 前端按 permissions.includes(code) 控制按钮，无需特判 admin 角色。
   */
  private async toSafeUserWithRbac(user: User): Promise<SafeUser> {
    const base = this.toSafeUser(user);
    const roles = user.roles ?? [];
    const roleCodes = roles.map((role) => role.code);
    let permissions: string[];
    if (roleCodes.includes(ADMIN_ROLE_CODE)) {
      const all = await this.permissions.find({ select: { code: true } });
      permissions = all.map((permission) => permission.code);
    } else {
      const permissionSet = new Set<string>();
      for (const role of roles) {
        for (const permission of role.permissions ?? []) {
          permissionSet.add(permission.code);
        }
      }
      permissions = [...permissionSet];
    }
    return { ...base, roles: roleCodes, permissions };
  }

  /** 显式挑选对外基础字段（不含 RBAC 与敏感列）；roles/permissions 由 toSafeUserWithRbac 组装 */
  private toSafeUser(user: User): Omit<SafeUser, 'roles' | 'permissions'> {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      phone: user.phone,
      nickname: user.nickname,
      realName: user.realName,
      gender: user.gender,
      birthDate: user.birthDate,
      avatarUrl: user.avatarUrl,
      emailVerifiedAt: user.emailVerifiedAt,
      phoneVerifiedAt: user.phoneVerifiedAt,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
