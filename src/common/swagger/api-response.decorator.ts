import { ApiResponse } from '@nestjs/swagger';

/**
 * OpenAPI SchemaObject 的最小自包含类型：只声明本文件用到的字段。
 * 不用 @nestjs/swagger/dist/... 的内部类型——那是实现细节路径，
 * 版本升级可能变更导致 "error 类型"（本文件曾因此触发 no-unsafe-* 规则）。
 */
export interface SchemaObject {
  /** OpenAPI 引用（对 DTO 类 schema，如 { $ref: getSchemaPath(XxxDto) }） */
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  example?: unknown;
  nullable?: boolean;
  properties?: Record<string, SchemaObject>;
  required?: string[];
}

/**
 * Swagger 响应文档共享装饰器：把统一响应信封（`{ code, message, data, path, timestamp }`，
 * 见 common/utils/api-response.ts）文档化到每个接口的 Responses 区。
 * 直接给接口加 @ApiResponse 会让每个端点重复写一遍信封结构；这里的工厂函数
 * 统一生成信封 schema，data 形状按接口传入。
 * 用法（控制器中）：
 *   @ApiOkEnvelope('登录成功，返回令牌对', TOKEN_PAIR_SCHEMA)
 *   @Post('login')
 *   方法(...) {}
 */

/** 信封中 data 的取值：对象 schema（$ref 字段已包含在 SchemaObject 内） */
export type EnvelopeData = SchemaObject;

/** 统一信封 schema；data 未提供时按"此接口无数据返回"（null）处理 */
const envelope = (data?: EnvelopeData): SchemaObject => ({
  type: 'object',
  properties: {
    code: {
      type: 'number',
      description: '业务码：0 表示成功，非 0 见各接口失败响应说明',
      example: 0,
    },
    message: { type: 'string', description: '提示信息', example: '成功' },
    data: data ?? {
      type: 'null',
      description: '成功载荷；此接口无数据返回（如注册）',
    },
    path: {
      type: 'string',
      description: '请求路径（不含 query，避免搜索词/令牌等敏感信息入日志）',
      example: '/api/auth/login',
    },
    timestamp: {
      type: 'string',
      format: 'date-time',
      description: '响应生成时间（ISO 8601）',
    },
  },
  required: ['code', 'message', 'data', 'path', 'timestamp'],
});

/** 200 成功响应：统一信封 + 指定的 data 形状 */
export function ApiOkEnvelope(
  description: string,
  data?: EnvelopeData,
): MethodDecorator {
  return ApiResponse({ status: 200, description, schema: envelope(data) });
}

/** 201 创建成功响应：统一信封 + 指定的 data 形状 */
export function ApiCreatedEnvelope(
  description: string,
  data?: EnvelopeData,
): MethodDecorator {
  return ApiResponse({ status: 201, description, schema: envelope(data) });
}

/**
 * 接口特有的失败响应装饰器。
 * 401（未认证/令牌失效）与 429（全局限速）是通用契约——所有受保护接口
 * 都返回 401、限速策略下所有接口都可能返回 429，逐个接口标注属于重复噪音，
 * 统一在 README「通用接口约定」说明；这里只保留"接口特有"的失败，
 * 如注册的 409（标识被占用）。
 */
export function ApiConflictResponse(): MethodDecorator {
  return ApiResponse({
    status: 409,
    description: '用户名、邮箱或手机号已被占用',
  });
}
