import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  CreateUserDto,
  ListUsersQuery,
  UpdateUserDto,
  UpdateUserStatusDto,
} from '@/modules/users/users.dto';

/**
 * users DTO 校验单测：钉住装饰器规则（合法/非法样例）。
 * 覆盖 @Type 转换分支（单测 cov 不含 e2e 的 ValidationPipe 路径，
 * 这里直接走 class-validator 补上）。
 */
describe('users DTO 校验', () => {
  describe('ListUsersQuery', () => {
    it('字符串页码/页大小被转换为数字（@Type 分支）', () => {
      const dto = plainToInstance(ListUsersQuery, {
        page: '2',
        pageSize: '50',
      });
      const errors = validateSync(dto);
      expect(errors).toHaveLength(0);
      expect(dto.page).toBe(2);
      expect(dto.pageSize).toBe(50);
    });

    it('越界值被拒绝', () => {
      const errors = validateSync(
        plainToInstance(ListUsersQuery, { page: 0, pageSize: 101 }),
      );
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('CreateUserDto', () => {
    it('合法输入通过（含选填邮箱/手机号/昵称）', () => {
      const errors = validateSync(
        plainToInstance(CreateUserDto, {
          username: 'alice',
          password: 'secret123',
          email: 'a@b.com',
          phone: '+8613800138000',
          nickname: 'A',
        }),
      );
      expect(errors).toHaveLength(0);
    });

    it('纯数字用户名（6-20 位）被拒绝：会被登录标识路由当成手机号', () => {
      const errors = validateSync(
        plainToInstance(CreateUserDto, {
          username: '123456',
          password: 'secret123',
        }),
      );
      expect(errors.length).toBeGreaterThan(0);
    });

    it('非法邮箱/超短密码被拒绝', () => {
      const errors = validateSync(
        plainToInstance(CreateUserDto, {
          username: 'alice',
          password: 'short',
          email: 'not-an-email',
        }),
      );
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('UpdateUserStatusDto', () => {
    it('仅接受 active/disabled/banned', () => {
      expect(
        validateSync(
          plainToInstance(UpdateUserStatusDto, { status: 'active' }),
        ),
      ).toHaveLength(0);
      expect(
        validateSync(
          plainToInstance(UpdateUserStatusDto, { status: 'banned' }),
        ),
      ).toHaveLength(0);
      expect(
        validateSync(plainToInstance(UpdateUserStatusDto, { status: 'x' })),
      ).toHaveLength(1);
    });
  });

  describe('UpdateUserDto', () => {
    it('可选字段缺省通过；非法性别被拒绝', () => {
      expect(validateSync(plainToInstance(UpdateUserDto, {}))).toHaveLength(0);
      expect(
        validateSync(plainToInstance(UpdateUserDto, { gender: 'x' })),
      ).toHaveLength(1);
    });
  });
});
