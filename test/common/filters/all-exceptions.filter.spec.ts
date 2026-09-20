import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';

import { BusinessException } from '../../../src/common/exceptions/business.exception';
import { AllExceptionsFilter } from '../../../src/common/filters/all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let response: { status: jest.Mock; json: jest.Mock; setHeader: jest.Mock };
  let jsonBodies: unknown[];

  const createHost = (url = '/api/test'): ArgumentsHost =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ url, method: 'GET' }),
      }),
    }) as unknown as ArgumentsHost;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jsonBodies = [];
    response = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      json: jest.fn((body: unknown) => {
        jsonBodies.push(body);
      }),
    };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('业务异常返回 HTTP 200 + 业务 code', () => {
    filter.catch(new BusinessException('库存不足', 40001), createHost());
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 40001, message: '库存不足', data: null }),
    );
  });

  it('HttpException 的中文校验消息原样透传', () => {
    filter.catch(new BadRequestException('请求参数错误'), createHost());
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 400, message: '请求参数错误' }),
    );
  });

  it('404 框架文案被翻译为接口不存在', () => {
    filter.catch(
      new NotFoundException('Cannot GET /api/notexist'),
      createHost('/api/notexist'),
    );
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 404,
        message: '接口不存在',
        path: '/api/notexist',
      }),
    );
  });

  it('未知异常返回固定中文文案且不泄漏堆栈', () => {
    filter.catch(new Error('secret detail'), createHost());
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 500,
        message: '服务器内部错误，请稍后重试',
      }),
    );
    const body = jsonBodies[0] as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('secret detail');
  });

  it('非 HTTP 上下文不吞异常，直接抛出', () => {
    const wsHost = {
      getType: () => 'ws',
      switchToWs: () => ({}),
    } as unknown as ArgumentsHost;
    expect(() => filter.catch(new Error('ws boom'), wsHost)).toThrow('ws boom');
    expect(response.json).not.toHaveBeenCalled();
  });
});
