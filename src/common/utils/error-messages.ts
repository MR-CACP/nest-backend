/**
 * 错误消息中文化：
 * - DTO 中已自定义中文 message 的校验错误直接透传
 * - class-validator / ValidationPipe 默认英文消息按模板翻译（兜底）
 *   （模板与当前依赖版本绑定：升级 class-validator 后需复核 test/common/utils/error-messages.spec.ts）
 * - 框架级错误（404 / 429 / JSON 解析失败 / 5xx 等）统一映射为固定中文文案，
 *   既保证全中文展示，也避免向客户端泄漏内部细节
 */

import type { ValidationError } from 'class-validator';

/** class-validator 默认消息中的类型短语翻译 */
const TYPE_WORDS: Record<string, string> = {
  'a string': '字符串',
  'a number': '数字',
  'an integer number': '整数',
  'a positive number': '正数',
  'a boolean': '布尔值',
  'an array': '数组',
  'an object': '对象',
  'a Date instance': '日期',
  'an email': '合法的邮箱地址',
  'a UUID': '合法的 UUID',
  'an ISO8601 date': 'ISO8601 日期',
  'an URL': '合法的 URL',
};

/** 翻译单条校验错误消息（来自 class-validator 默认英文模板） */
export function translateValidationMessage(message: string): string {
  // "each value in xxx must be ..." —— 数组元素校验
  let rest = message;
  let prefix = '';
  const each = message.match(/^each value in (.+)$/);
  if (each) {
    prefix = '数组元素 ';
    rest = each[1];
  }

  const blocked = rest.match(/^property (\S+) should not exist$/);
  if (blocked) return `${prefix}不允许提交字段 "${blocked[1]}"`;

  const missing = rest.match(/^property (\S+) is missing$/);
  if (missing) return `${prefix}缺少必填字段 "${missing[1]}"`;

  const empty = rest.match(/^(\S+) (?:should|must) not be empty$/);
  if (empty) return `${prefix}${empty[1]} 不能为空`;

  const max = rest.match(/^(\S+) must not be greater than (\S+)$/);
  if (max) return `${prefix}${max[1]} 不能大于 ${max[2]}`;

  const min = rest.match(/^(\S+) must not be less than (\S+)$/);
  if (min) return `${prefix}${min[1]} 不能小于 ${min[2]}`;

  const maxLen = rest.match(
    /^(\S+) must be shorter than or equal to (\S+) characters$/,
  );
  if (maxLen) return `${prefix}${maxLen[1]} 长度不能超过 ${maxLen[2]} 个字符`;

  const minLen = rest.match(
    /^(\S+) must be longer than or equal to (\S+) characters$/,
  );
  if (minLen) return `${prefix}${minLen[1]} 长度不能少于 ${minLen[2]} 个字符`;

  const mustBe = rest.match(/^(\S+) must be (.+)$/);
  if (mustBe)
    return `${prefix}${mustBe[1]} 必须是${TYPE_WORDS[mustBe[2]] ?? ` ${mustBe[2]}`}`;

  // 未命中已知模板：视为业务方自定义的中文消息，原样透传
  return prefix + rest;
}

/** 校验错误扁平化为一条中文消息（供 ValidationPipe 的 exceptionFactory 使用） */
export function formatValidationErrors(errors: ValidationError[]): string {
  const messages: string[] = [];
  const walk = (error: ValidationError, parentPath?: string): void => {
    const path = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    if (error.constraints) {
      for (const raw of Object.values(error.constraints)) {
        const translated = translateValidationMessage(raw);
        // 顶层字段名已包含在消息里；嵌套字段补充完整路径
        messages.push(parentPath ? `${path}: ${translated}` : translated);
      }
    }
    for (const child of error.children ?? []) walk(child, path);
  };
  errors.forEach((error) => walk(error));
  // 兜底：错误未携带 constraints 时 messages 可能为空，避免返回空串
  return messages.join('; ') || '请求参数校验失败';
}

/** 翻译框架级 HTTP 异常消息；校验类消息（已中文化）原样透传 */
export function translateHttpMessage(status: number, message: string): string {
  // body-parser 抛出的 SyntaxError 文案。必须限定 400 + 已知解析错误模式，
  // 否则 message 恰好含 "json" 子串的 404/5xx 会被错误改写，掩盖真实故障
  if (
    status === 400 &&
    /(Unexpected end of JSON input|Unexpected token|is not valid JSON|JSON at position)/.test(
      message,
    )
  ) {
    return '请求体 JSON 格式错误';
  }
  // Nest 未匹配路由："Cannot GET /api/xxx"
  if (/^Cannot \S+ /.test(message)) return '接口不存在';
  if (status === 401) return '未登录或登录已失效';
  if (status === 403) return '没有访问权限';
  if (status === 404) return '接口不存在';
  if (status === 405) return '请求方法不支持';
  if (status === 413) return '请求体过大';
  if (status === 429) return '请求过于频繁，请稍后再试';
  if (status >= 500) return '服务器内部错误，请稍后重试';
  // 400 / 422 等参数校验消息已由 ValidationPipe 中文化，原样透传
  return message;
}
