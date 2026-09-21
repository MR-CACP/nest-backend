import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';

import { User } from './entities/user.entity';

/** 经过 JwtAuthGuard 的请求：user.id 来自访问令牌载荷（sub） */
export interface AuthenticatedRequest extends Request {
  user: { id: string };
}

/**
 * 访问令牌守卫：校验 Authorization: Bearer <JWT>，并复查账号状态。
 * 不引入 passport（省依赖）：JWT 解析用 @nestjs/jwt 自带能力。
 * 令牌无效/过期/缺失一律 401（前端据此走刷新流程）。
 * 状态复查（查库）：access 路径即时封禁——账号被禁用/软删后旧令牌立即失效，
 * 不依赖 access TTL（15 分钟）自然过期；与 refresh() 的状态校验同语义
 * （被封禁账号既不能刷新续期，也不能继续访问）。代价：每个受保护请求一次
 * 主键查询（毫秒级），换取"撤销即时生效"。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(User)
    private readonly users: Repository<User>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      throw new UnauthorizedException('未登录');
    }
    // 只捕获令牌异常：verifyAsync 失败（无效/过期/签名不符）才是"登录失效"。
    // 数据库查询异常（断连/超时）不能在这里吞掉——错误转换会误导客户端
    // 去刷新/清会话，同时掩盖服务故障；让它原样抛出，由全局过滤器转成 500/503
    let payload: { sub?: unknown };
    try {
      payload = await this.jwtService.verifyAsync<{ sub?: unknown }>(token);
    } catch {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
    // 载荷最小化：只签 sub（userId），其余用户信息按需查库，
    // 避免角色/状态变更后旧令牌仍携带过期权限信息。
    // sub 缺失/非字符串（异常签发方或损坏令牌）视为无效而非 500：
    // 携带 undefined 查库会退化为无条件的全表首行，属于越权读取
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedException('登录已过期，请重新登录');
    }
    // 状态复查：软删（deletedAt 非空，findOneBy 默认过滤）与禁用账号一律拒绝。
    // 此查询不受 try/catch 保护——DB 故障必须显性暴露，不能伪装成登录失效
    const user = await this.users.findOneBy({ id: payload.sub });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('账号不可用，请重新登录');
    }
    request.user = { id: payload.sub };
    return true;
  }
}
