import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  genRequestId,
  REQUEST_ID_HEADER,
} from '../../../src/common/utils/request-id';

/** 测试用响应对象：保持本地强类型，仅在调用 genRequestId 时转成 ServerResponse */
type ResLike = {
  headers: Record<string, string>;
  setHeader: (name: string, value: string) => void;
};

describe('genRequestId（pino-http 关联 ID）', () => {
  const makeRes = (): ResLike => {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader: (name, value) => {
        headers[name] = value;
      },
    };
  };

  const toServerResponse = (res: ResLike): ServerResponse =>
    res as unknown as ServerResponse;

  it('复用合法传入的 X-Request-Id 并回写响应头', () => {
    const res = makeRes();
    const id = genRequestId(
      {
        headers: { [REQUEST_ID_HEADER]: 'trace-123' },
      } as unknown as IncomingMessage,
      toServerResponse(res),
    );
    expect(id).toBe('trace-123');
    expect(res.headers['x-request-id']).toBe('trace-123');
  });

  it('缺失时生成 UUID 并回写响应头', () => {
    const res = makeRes();
    const id = genRequestId(
      { headers: {} } as unknown as IncomingMessage,
      toServerResponse(res),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).toBe(id);
  });

  it.each(['', '   ', 'x'.repeat(129)])(
    '非法值（%j）回退 UUID，防 header 滥用',
    (bad) => {
      const res = makeRes();
      const id = genRequestId(
        {
          headers: { [REQUEST_ID_HEADER]: bad },
        } as unknown as IncomingMessage,
        toServerResponse(res),
      );
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
});
