import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DataSource, FindOperator, Repository } from 'typeorm';

// expect.anything()/objectContaining 返回 any（@types/jest），直接放进断言触发
// no-unsafe-assignment；包成显式类型占位（值仅用于编译期，断言匹配由 jest 运行时完成）
const MATCHER_ANY = expect.anything() as unknown as Date | null;
const MATCHER_LOCK_OPTIONS = expect.objectContaining({
  lock: { mode: 'pessimistic_write' },
}) as unknown as FindOperator<unknown>;

import { RefreshToken } from '@/modules/auth/entities/refresh-token.entity';
import { User } from '@/modules/auth/entities/user.entity';
import { SessionsService } from '@/modules/sessions/sessions.service';

/** 查询构造器 mock 形状（链式方法全部返回自身——service 用的就是这一个实例） */
type QbMock = {
  innerJoin: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  select: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  skip: jest.Mock;
  take: jest.Mock;
  getManyAndCount: jest.Mock;
};

const makeQueryBuilder = (): QbMock => {
  const qb: QbMock = {
    innerJoin: jest.fn(() => qb),
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    select: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    addOrderBy: jest.fn(() => qb),
    skip: jest.fn(() => qb),
    take: jest.fn(() => qb),
    getManyAndCount: jest.fn(),
  };
  return qb;
};

/**
 * SessionsService 单测：在线列表（筛选/投影）+ 强制下线（CAS 撤销 / 事务踢出）。
 * 事务通过 mock DataSource.transaction 验证：manager 返回独立 txRepos，
 * 断言撤销与版本递增发生在 manager 仓库上（TypeORM 默认仓库不受事务保护）。
 */
describe('SessionsService', () => {
  let service: SessionsService;
  let refreshTokens: {
    createQueryBuilder: jest.Mock;
    update: jest.Mock;
    findOneBy: jest.Mock;
  };
  let users: { findOne: jest.Mock };
  let txRepos: { findOne: jest.Mock; update: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  // 操作审计 mock：顶层声明，it 回调可直接断言 record 调用
  let audit: { record: jest.Mock };

  beforeEach(() => {
    refreshTokens = {
      createQueryBuilder: jest.fn(),
      update: jest.fn(),
      findOneBy: jest.fn(),
    };
    users = { findOne: jest.fn() };
    txRepos = { findOne: jest.fn(), update: jest.fn() };
    audit = { record: jest.fn() };
    dataSource = {
      transaction: jest.fn(async (fn: (m: unknown) => Promise<unknown>) =>
        fn({ getRepository: () => txRepos }),
      ),
    };
    service = new SessionsService(
      refreshTokens as unknown as Repository<RefreshToken>,
      users as unknown as Repository<User>,
      dataSource as unknown as DataSource,
      audit as never,
    );
  });

  describe('list', () => {
    it('只返回在线行（revoked_at IS NULL 且未过期），username 筛选走 join users', async () => {
      const qb = makeQueryBuilder();
      refreshTokens.createQueryBuilder.mockReturnValue(qb);
      qb.getManyAndCount.mockResolvedValue([
        [
          {
            id: 's1',
            userId: 'u1',
            user: { username: 'alice' },
            ip: '1.1.1.1',
            userAgent: 'UA',
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 60000),
            revokedAt: null,
          },
        ],
        1,
      ]);

      const result = await service.list({ page: 1, pageSize: 10 });

      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        id: 's1',
        userId: 'u1',
        username: 'alice',
        ip: '1.1.1.1',
      });
      // 在线判定：未撤销 + 未过期
      expect(qb.where).toHaveBeenCalledWith('rt.revoked_at IS NULL');
      expect(qb.andWhere).toHaveBeenCalledWith(
        'rt.expires_at > :now',
        expect.anything(),
      );
      // 默认不带筛选（未传 userId/username 时无额外 andWhere）
      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      // 投影：显式 select（tokenHash 不外泄）+ 最近登录在前
      expect(qb.select).toHaveBeenCalledWith(
        expect.arrayContaining([
          'rt.id',
          'rt.userId',
          'u.username',
          'rt.createdAt',
          'rt.expiresAt',
          'rt.revokedAt',
        ]),
      );
      expect(qb.orderBy).toHaveBeenCalledWith('rt.created_at', 'DESC');
      // (created_at, id) 双键：同时间戳行 offset 翻页稳定（id 作决胜键）
      expect(qb.addOrderBy).toHaveBeenCalledWith('rt.id', 'DESC');
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(10);
    });

    it('userId / username 筛选：追加对应 andWhere', async () => {
      const qb = makeQueryBuilder();
      refreshTokens.createQueryBuilder.mockReturnValue(qb);
      qb.getManyAndCount.mockResolvedValue([[], 0]);

      await service.list({
        userId: 'u9',
        username: 'bob',
        page: 2,
        pageSize: 50,
      });

      expect(qb.andWhere).toHaveBeenCalledWith('rt.user_id = :userId', {
        userId: 'u9',
      });
      expect(qb.andWhere).toHaveBeenCalledWith('u.username = :username', {
        username: 'bob',
      });
      expect(qb.skip).toHaveBeenCalledWith(50);
      expect(qb.take).toHaveBeenCalledWith(50);
    });

    it('pageSize 超上限收敛到 100（防拖库）', async () => {
      const qb = makeQueryBuilder();
      refreshTokens.createQueryBuilder.mockReturnValue(qb);
      qb.getManyAndCount.mockResolvedValue([[], 0]);

      await service.list({ pageSize: 999 });

      expect(qb.take).toHaveBeenCalledWith(100);
    });
  });

  describe('revokeOne', () => {
    it('CAS 撤销成功（affected=1）→ 正常返回（先查会话 + 降级判定放行）', async () => {
      refreshTokens.findOneBy.mockResolvedValue({ id: 's1', userId: 'u1' });
      users.findOne
        .mockResolvedValueOnce({ id: 'u1', roles: [] })
        .mockResolvedValueOnce({ id: 'op1', roles: [{ code: 'admin' }] });
      refreshTokens.update.mockResolvedValue({ affected: 1 });

      await expect(service.revokeOne('s1', 'op1')).resolves.toBeUndefined();
      // 先取会话（含撤销状态）→ 目标用户 roles 用于降级判定
      expect(refreshTokens.findOneBy).toHaveBeenCalledWith({
        id: 's1',
        revokedAt: MATCHER_ANY,
      });
      // 条件撤销：只撤销仍在线（revoked_at IS NULL）的行
      expect(refreshTokens.update).toHaveBeenCalledWith(
        { id: 's1', revokedAt: MATCHER_ANY },
        MATCHER_ANY,
      );
      // 操作审计：resourceType=session + resourceId=会话 ID + detail.userId
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'session.revoke',
          operatorId: 'op1',
          resourceType: 'session',
          resourceId: 's1',
          detail: { userId: 'u1' },
        }),
      );
    });

    it('已下线/不存在（affected=0）→ 404（REST 语义，与幂等成功区分）', async () => {
      refreshTokens.findOneBy.mockResolvedValue(null); // 会话不存在或已下线
      await expect(service.revokeOne('s1', 'op1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(users.findOne).not.toHaveBeenCalled(); // 不进降级判定
      expect(refreshTokens.update).not.toHaveBeenCalled();
    });

    it('降级防护：非 admin 撤销管理员单会话 → 403（与全部下线同口径）', async () => {
      refreshTokens.findOneBy.mockResolvedValue({ id: 's1', userId: 'admin1' });
      users.findOne
        .mockResolvedValueOnce({ id: 'admin1', roles: [{ code: 'admin' }] })
        .mockResolvedValueOnce({ id: 'op1', roles: [{ code: 'session-ops' }] });
      await expect(service.revokeOne('s1', 'op1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(refreshTokens.update).not.toHaveBeenCalled();
    });

    it('admin 操作者撤销管理员单会话 → 放行（旁路）', async () => {
      refreshTokens.findOneBy.mockResolvedValue({ id: 's1', userId: 'admin1' });
      users.findOne
        .mockResolvedValueOnce({ id: 'admin1', roles: [{ code: 'admin' }] })
        .mockResolvedValueOnce({ id: 'op1', roles: [{ code: 'admin' }] });
      refreshTokens.update.mockResolvedValue({ affected: 1 });
      await expect(service.revokeOne('s1', 'op1')).resolves.toBeUndefined();
    });
  });

  describe('revokeAllByUser', () => {
    it('事务内：锁用户行 → 撤销全部活跃会话 + 递增 session_version（旧 access 即时失效）', async () => {
      // 降级判定：target（普通用户）+ operator（admin 旁路 → 放行）
      users.findOne
        .mockResolvedValueOnce({ id: 'u1', roles: [] })
        .mockResolvedValueOnce({ id: 'op1', roles: [{ code: 'admin' }] });
      txRepos.findOne.mockResolvedValue({ id: 'u1', sessionVersion: 3 });
      refreshTokens.update.mockResolvedValue({ affected: 0 });

      await service.revokeAllByUser('u1', 'op1');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      // 撤销 + 版本递增都在 manager 仓库上（事务内必须 manager，默认仓库立即提交）
      expect(txRepos.update).toHaveBeenCalledTimes(2);
      expect(txRepos.update).toHaveBeenCalledWith(
        { userId: 'u1', revokedAt: MATCHER_ANY },
        MATCHER_ANY,
      );
      expect(txRepos.update).toHaveBeenCalledWith(
        { id: 'u1' },
        { sessionVersion: 4 },
      );
      // 锁用户行：并发踢人/删除下版本号基于锁内读到的值
      expect(txRepos.findOne).toHaveBeenCalledWith(MATCHER_LOCK_OPTIONS);
      // 操作审计：resourceType=user（resourceId 是用户 ID 而非会话 ID）+ operatorId 透传
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'session.revoke_all',
          operatorId: 'op1',
          resourceType: 'user',
          resourceId: 'u1',
        }),
      );
    });

    it('用户不存在 → 404，事务内不执行任何写', async () => {
      users.findOne.mockResolvedValue(null); // target 查不到（降级判定前置检查）
      await expect(
        service.revokeAllByUser('999', 'op1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(users.findOne).toHaveBeenCalledTimes(1); // 不再查 operator
      expect(txRepos.update).not.toHaveBeenCalled();
    });

    it('降级防护：非 admin 操作者下线持 admin 角色的账号 → 403（不执行事务）', async () => {
      users.findOne
        .mockResolvedValueOnce({ id: 'admin1', roles: [{ code: 'admin' }] })
        .mockResolvedValueOnce({ id: 'op1', roles: [{ code: 'session-ops' }] });
      await expect(
        service.revokeAllByUser('admin1', 'op1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('降级防护：操作者不存在 → 403（与 users 管理口径一致）', async () => {
      users.findOne
        .mockResolvedValueOnce({ id: 'u1', roles: [] })
        .mockResolvedValueOnce(null); // operator 查不到
      await expect(
        service.revokeAllByUser('u1', 'ghost'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });
});
