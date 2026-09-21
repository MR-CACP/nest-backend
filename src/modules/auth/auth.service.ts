import { createHash, randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { compare, hash } from 'bcrypt';
import { PinoLogger } from 'nestjs-pino';
import {
  DataSource,
  EntityManager,
  FindOptionsWhere,
  IsNull,
  QueryFailedError,
  Repository,
} from 'typeorm';

import { BusinessException } from '../../common/exceptions/business.exception';
import type { JwtConfig } from '../../config/types';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
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
>;

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
    this.assertPasswordByteLength(dto.password);
    await this.ensureAccountAvailable(dto);
    const passwordHash = await hash(dto.password, 10); // cost 10：约 50-100ms，抗 GPU 爆破
    const user = await this.saveUserSafely({
      username: dto.username,
      // 规范化：邮箱小写、手机号去分隔符——PG varchar 大小写敏感，
      // 不规范化会出现 Alice@x.com 与 alice@x.com 两个账号
      email: this.normalizeEmail(dto.email),
      phone: this.normalizePhone(dto.phone),
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
          account: this.maskAccount(dto.account),
          ip,
          userAgent,
        },
        '登录失败：账号或密码错误',
      );
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
      // 业务结果而非框架故障：走业务码契约，前端可区分"凭据错误(401)"与"账号被禁(bizCode)"
      throw new BusinessException('账号已被禁用', ACCOUNT_DISABLED_BIZ_CODE);
    }

    const tokens = await this.issueTokenPair(undefined, user.id, ip, userAgent);
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
   * 注意执行顺序：先查用户并校验状态，再撤销/签发——令牌落库前失败不会留下
   * revoked_at IS NULL 的孤儿会话；被封禁账号也无法通过刷新续期。
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
    // 先查用户：令牌有效但用户已被删除（软删）→ 直接 401
    const user = await this.users.findOneBy({ id: token.userId });
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }
    if (user.status !== 'active') {
      throw new BusinessException('账号已被禁用', ACCOUNT_DISABLED_BIZ_CODE);
    }
    // 轮换 = 单个事务里的 compare-and-swap：
    // ① 撤销条件带 revokedAt IS NULL 且必须恰好影响 1 行——并发请求共用同一 refresh token 时，
    //    前置 findOneBy 都会读到"未撤销"而通过检查，只有先撤销成功者能续期，后到者
    //    update affected=0 → 401（README 的"后到者必然 401"因此成立）；同时避免第二次
    //    update 把首次轮换时刻往后刷（审计时间被重写）；
    // ② "撤销旧令牌 + 落库新令牌"必须同生共死：若撤销成功而新令牌落库失败（DB 抖动），
    //    事务整体回滚——旧令牌保持有效，客户端可直接重试刷新；否则会出现"旧令牌已撤销、
    //    新令牌未落库"，用户被迫重新登录。
    //    ⚠ 事务内的所有读写都必须走 manager：this.refreshTokens 绑定默认连接，
    //    在事务回调里用它执行 UPDATE 会在独立连接上立即提交、不受回滚保护，
    //    原子性形同虚设——撤销必须经 manager.getRepository 执行。
    // 已轮换令牌再次出现即"可能被盗用"信号，后续盗用检测（撤销该用户全部会话）可挂在这里。
    const tokens = await this.dataSource.transaction(async (manager) => {
      const revoked = await manager
        .getRepository(RefreshToken)
        .update(
          { id: token.id, revokedAt: IsNull() },
          { revokedAt: new Date() },
        );
      if (revoked.affected !== 1) {
        throw new UnauthorizedException('刷新令牌无效或已过期');
      }
      return this.issueTokenPair(manager, token.userId, ip, userAgent);
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
    const user = await this.users.findOneBy({ id: userId });
    if (!user) {
      throw new UnauthorizedException('用户不存在');
    }
    return this.toSafeUser(user);
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
      return { email: this.normalizeEmail(account) ?? undefined };
    }
    const phone = this.normalizePhone(account);
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
          ? [{ email: this.normalizeEmail(dto.email) ?? undefined }]
          : []),
        ...(dto.phone
          ? [{ phone: this.normalizePhone(dto.phone) ?? undefined }]
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
      if (this.isUniqueViolation(err)) {
        throw new ConflictException('用户名、邮箱或手机号已被占用');
      }
      throw err;
    }
  }

  /** 是否为 PostgreSQL 唯一约束冲突（SQLSTATE 23505） */
  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof QueryFailedError &&
      (err.driverError as { code?: string } | undefined)?.code === '23505'
    );
  }

  /**
   * 签发访问令牌 + 刷新令牌（刷新令牌落库，返回明文）。
   * @param manager 可选事务管理器：refresh 轮换在事务内调用（撤销+落库原子）；
   *                登录无撤销操作，不传（走默认仓库）。
   */
  private async issueTokenPair(
    manager: EntityManager | undefined,
    userId: string,
    ip: string,
    userAgent: string,
  ): Promise<Omit<TokenPair, 'user'>> {
    const jwt = this.configService.getOrThrow<JwtConfig>('jwt');
    const accessToken = await this.jwtService.signAsync({ sub: userId });
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
        ip: ip.slice(0, 45) || null,
        userAgent: userAgent.slice(0, 255) || null,
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

  /** bcrypt 只处理前 72 字节：超长（如 72 个汉字=216 字节）会被静默截断，直接拒绝 */
  private assertPasswordByteLength(password: string): void {
    if (Buffer.byteLength(password, 'utf8') > 72) {
      throw new BadRequestException('密码过长（不能超过 72 字节）');
    }
  }

  /** 邮箱规范化：小写（PG varchar 大小写敏感，避免同邮箱双账号） */
  private normalizeEmail(email: string | undefined): string | null {
    return email ? email.trim().toLowerCase() : null;
  }

  /** 手机号规范化：去空格/连字符（保留可选 + 区号前缀） */
  private normalizePhone(phone: string | undefined): string | null {
    return phone ? phone.replace(/[\s-]/g, '') : null;
  }

  /**
   * 登录标识日志脱敏：邮箱/手机号是 PII，不落明文日志
   * （与异常过滤器"query 不入日志"同一立场，见 all-exceptions.filter.ts）。
   * 用户名本身非敏感，原样保留便于排障。
   */
  private maskAccount(account: string): string {
    if (account.includes('@')) {
      const [name, domain] = account.split('@');
      return `${name.charAt(0)}***@${domain}`;
    }
    // 先规范化再去分隔符判定：原始输入可能含空格/连字符（如 '+86 138-0013-8000'），
    // 直接对原始串匹配会失败、把 PII 明文写进日志
    const normalized = this.normalizePhone(account);
    if (normalized && /^\+?\d{6,20}$/.test(normalized)) {
      return normalized.length > 7
        ? `${normalized.slice(0, 3)}****${normalized.slice(-4)}`
        : '***';
    }
    return account;
  }

  /** 显式挑选对外字段，杜绝 passwordHash/deletedAt 外泄 */
  private toSafeUser(user: User): SafeUser {
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
