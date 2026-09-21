import {
  translateHttpMessage,
  translateValidationMessage,
} from '../../../src/common/utils/error-messages';

describe('错误消息中文化', () => {
  describe('translateValidationMessage', () => {
    it.each([
      ['property hack should not exist', '不允许提交字段 "hack"'],
      ['property name is missing', '缺少必填字段 "name"'],
      ['name should not be empty', 'name 不能为空'],
      ['name must not be empty', 'name 不能为空'],
      ['name must be a string', 'name 必须是字符串'],
      ['age must be an integer number', 'age 必须是整数'],
      ['age must not be greater than 150', 'age 不能大于 150'],
      ['age must not be less than 0', 'age 不能小于 0'],
      [
        'name must be shorter than or equal to 10 characters',
        'name 长度不能超过 10 个字符',
      ],
      [
        'name must be longer than or equal to 2 characters',
        'name 长度不能少于 2 个字符',
      ],
      ['email must be an email', 'email 必须是合法的邮箱地址'],
      ['each value in tags must be a string', '数组元素 tags 必须是字符串'],
      [
        'each value in property tags should not exist',
        '数组元素 不允许提交字段 "tags"',
      ],
      // 业务方自定义的中文消息原样透传
      ['name 不能为空', 'name 不能为空'],
    ])('%s -> %s', (input, expected) => {
      expect(translateValidationMessage(input)).toBe(expected);
    });
  });

  describe('translateHttpMessage', () => {
    it.each([
      [400, 'Unexpected end of JSON input', '请求体 JSON 格式错误'],
      [400, '{name:tom} is not valid JSON', '请求体 JSON 格式错误'],
      [404, 'Cannot GET /api/notexist', '接口不存在'],
      [401, 'Unauthorized', '未登录或登录已失效'],
      [403, 'Forbidden resource', '没有访问权限'],
      [405, 'Method Not Allowed', '请求方法不支持'],
      [413, 'Payload Too Large', '请求体过大'],
      [
        429,
        'ThrottlerException: Too Many Requests',
        '请求过于频繁，请稍后再试',
      ],
      [500, 'some internal detail', '服务器内部错误，请稍后重试'],
      // 503 依赖降级不是内部错误，文案单独区分
      [503, 'Service Unavailable', '服务暂时不可用，请稍后重试'],
      // 校验类消息（已中文化）原样透传
      [400, 'name 不能为空; age 必须是整数', 'name 不能为空; age 必须是整数'],
    ])('%i + %s -> %s', (status, input, expected) => {
      expect(translateHttpMessage(status, input)).toBe(expected);
    });
  });
});
