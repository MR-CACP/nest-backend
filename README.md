<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

<p align="center">基于 <a href="https://nestjs.com/" target="_blank">NestJS</a> 11 的 TypeScript 后端脚手架：开箱即用的配置体系、结构化日志、限速、统一响应与健康检查，集成 TypeORM（PostgreSQL）与 Redis。</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933" alt="Node.js >= 20" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6" alt="TypeScript" />
  <img src="https://img.shields.io/badge/NestJS-11-E0234E" alt="NestJS 11" />
  <img src="https://img.shields.io/badge/pnpm-12.4.2-F69220" alt="pnpm 12.4.2" />
  <img src="https://img.shields.io/badge/license-UNLICENSED-lightgrey" alt="License: UNLICENSED" />
</p>

---

## 目录

- [项目简介](#项目简介)
- [核心特性](#核心特性)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [运行测试](#运行测试)
- [认证接口](#认证接口)
- [数据层与迁移](#数据层与迁移)
- [健康检查与可观测性](#健康检查与可观测性)
- [项目规范](#项目规范)
- [部署](#部署)
- [API 文档](#api-文档)
- [已知取舍](#已知取舍)
- [许可证](#许可证)

---

## 项目简介

面向新手学习与二次开发的 NestJS 后端模板。默认提供**基础设施能力**（配置、日志、限速、统一响应、健康检查、数据库/缓存接入）、**认证模块**（注册/登录/刷新/登出/当前用户）与 **RBAC 权限体系**（角色/权限/分配关系 + 声明式守卫），审计等业务模块按需在 `src/modules/` 下扩展。

## 核心特性

- **分层配置**：`.env` + `.env.{NODE_ENV}` 两级加载，Joi 启动校验，内置 7 条生产安全策略（见[环境变量](#环境变量)）。
- **认证**：注册/登录/刷新/登出/当前用户五端点；access token（JWT，15 分钟）+ refresh token（httpOnly Cookie + 响应体回传，7 天，刷新即轮换）双令牌方案，密码 bcrypt 哈希、登录失败统一文案防枚举（详见[认证接口](#认证接口)）。**刷新失败是分裂语义：令牌无效/已撤销/过期为 HTTP 401，账号被禁为 HTTP 200 + 非零 `code`（`X-Business-Code: 10001`）——前端必须同时判 401 与非零 code，否则被禁客户端会反复重试刷新**。
- **结构化日志**：pino（nestjs-pino），自动请求关联 ID（`X-Request-Id` 与日志 `req.id` 同源），敏感请求头脱敏。
- **统一响应**：成功/失败共用 `{ code, message, data, path, timestamp }` 结构，由全局拦截器与异常过滤器保证。
- **业务异常契约**：`BusinessException` 返回 HTTP 200 + 业务码（国内业务码惯例），`X-Business-Code` 响应头 + warn 日志补偿可观测性。
- **限速**：`@nestjs/throttler`，计数存储可切换内存 / Redis（多副本共享）。
- **数据层**：TypeORM（PostgreSQL）连接池、SSL/超时/迁移专项配置；Redis 缓存门面（JSON 序列化 + 键前缀 + 失败降级）。
- **健康检查**：`/health/live`（进程存活）与 `/health/ready`（依赖就绪，各 2s 超时）分离，容器探针语义正确。
- **RBAC**：`roles / permissions / user_roles / role_permissions` 四表 + 种子角色（`admin` 旁路、`user`）；`@Roles` / `@Permissions` 声明式守卫，**每请求查库 → 角色/权限变更即时生效**（详见[RBAC 权限体系](#rbac-权限体系)）。
- **CI**：GitHub Actions 6 项检查（见[运行测试](#运行测试)），含 Docker 镜像构建 + 生产配置 smoke。

## 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 框架 | NestJS（`@nestjs/common` 等） | ^11.0.1 |
| 语言 | TypeScript | ^5.7.3 |
| 包管理 | pnpm | 12.4.2（`packageManager`） |
| 运行环境 | Node.js | >= 20 |
| ORM | TypeORM + `@nestjs/typeorm` | ^1.1.1 / ^11.0.3 |
| 数据库 | PostgreSQL（镜像 `postgres:18.6-alpine`） | 18.6 |
| 缓存 | Redis（镜像 `redis:8.10.1-alpine`），ioredis | ^5.11.1 |
| 配置校验 | Joi + `@nestjs/config` | ^18.2.9 / ^4.0.4 |
| 日志 | pino（nestjs-pino / pino-http / pino-pretty） | ^5.2.0 / ^11.0.0 / ^13.1.3 |
| 限速 | `@nestjs/throttler` + Redis 存储 | ^6.7.0 / ^1.2.0 |
| 安全 | helmet | ^8.3.0 |
| 认证 | `@nestjs/jwt` / bcrypt / cookie-parser | ^11.0.2 / ^6.0.0 / ^1.4.7 |
| API 文档 | `@nestjs/swagger` | ^11.4.7 |
| 测试 | Jest + Supertest | ^30.0.0 / ^7.0.0 |
| 代码质量 | ESLint 9 + Prettier（含 import 排序） | ^9.18.0 / ^3.4.2 |

## 目录结构

```text
src/
├── main.ts                  # 启动入口：NODE_ENV 校验、优雅停机、失败退出
├── app.module.ts            # 根模块：配置/日志/限速/数据库/Redis 装配
├── app.setup.ts             # 应用装配：helmet/代理信任/校验管道/前缀/CORS/Swagger
├── common/
│   ├── utils/               # api-response（统一响应）、request-id（日志关联）、error-messages（中文校验消息）
│   ├── exceptions/          # BusinessException（业务异常契约）
│   ├── filters/             # AllExceptionsFilter（统一错误响应 + 可观测性补偿）
│   ├── interceptors/        # TransformInterceptor（成功响应包装）
│   ├── constants/           # rbac.constants（ADMIN_ROLE_CODE 系统角色码，与迁移种子强同步）
│   └── decorators/          # rbac.decorator（@Roles/@Permissions + 元数据键，纯共享件）
├── config/                  # types（类型定义）/ env.validation（Joi 校验 + 安全策略）/ configuration（命名空间工厂）
├── database/                # database.module（运行时连接）/ data-source.ts（TypeORM CLI 迁移专用）
├── modules/
│   ├── auth/                # 认证模块：User / RefreshToken 实体 + 注册/登录/刷新/登出/me（JWT + Cookie 双令牌）
│   ├── rbac/                # RBAC 模块：实体 + RolesGuard + RbacService/RbacController（角色/权限管理端接口）
│   └── users/               # 用户管理模块：/api/users 列表/创建/资料/状态/角色分配（用户资源上的管理操作）
├── redis/                   # redis.service（缓存门面）/ redis.module（客户端构建，超时选项纯函数）
└── health/                  # health.controller（live/ready/check）+ health.module

test/                        # 测试目录，结构与 src/ 对应（28 单测 suite + 8 e2e suite）
```

## 快速开始

### 前置要求

| 依赖 | 要求 | 说明 |
|------|------|------|
| Node.js | >= 20 | `node -v` 确认 |
| pnpm | 12.x（锁定 12.4.2） | `corepack enable && corepack prepare pnpm@12.4.2 --activate` |
| Docker | 任意较新版本 | 仅用于起 PostgreSQL / Redis 依赖 |

### 安装与运行（开发模式）

```bash
$ pnpm install
$ cp .env.example .env        # 按需修改；默认凭证与 docker-compose.yml 一致
$ docker compose up -d        # 启动 postgres + redis（含健康检查与数据卷）
$ pnpm run start:dev          # NestJS 监听模式（热重载），入口 http://localhost:3000/api
```

postgres 容器首次初始化会自动创建 e2e 用的 `nest_test` 库（`docker/init/01-create-test-db.sh`）。

### 常用脚本

```bash
$ pnpm run start              # 开发模式（不监听）
$ pnpm run start:prod         # 生产模式（需先 pnpm run build）
$ pnpm run build              # 编译到 dist/
$ pnpm run lint:check         # ESLint 仅检查（CI 用）
$ pnpm run lint               # ESLint 检查并自动修复
$ pnpm run format             # Prettier 格式化
```

## 环境变量

### 加载约定

- 配置通过 `.env`（基础值）+ `.env.{NODE_ENV}`（环境覆盖）加载，完整模板见 `.env.example`。
- **`NODE_ENV` 必须由进程环境注入**：`package.json` scripts 已通过 `cross-env` 写入，生产部署由部署平台注入。不要写在 `.env.*` 文件里——加载哪个环境文件本身取决于该变量，属于循环依赖，实际无效。
- 敏感信息（密钥、密码）不要提交：个人覆盖值放 `.env.local` / `.env.{NODE_ENV}.local`（已 gitignore），生产环境由部署平台直接注入（`process.env` 优先级最高）。
- **`.env.*` 一律不入库**：`.env.example` 是唯一的提交模板，新成员复制为 `.env` 后按需修改；`.env.development` / `.env.test` 等环境文件同样被 gitignore，其默认值由 `.env.example` 与 Joi schema 的 default 提供。

### 变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 应用监听端口 |
| `API_PREFIX` | `api` | 全局路由前缀，所有接口在 `/api/...` 下 |
| `TRUST_PROXY` | `false` | 反向代理可信层数；无代理直连保持 `false`（防伪造 `X-Forwarded-For`），生产必填 |
| `LOG_LEVEL` | `info` | pino 日志级别：`fatal \| error \| warn \| info \| debug \| trace \| silent` |
| `SWAGGER_ENABLED` / `SWAGGER_PATH` | `false` / `docs` | Swagger 开关与路径；生产强制关闭 |
| `THROTTLE_TTL` / `THROTTLE_LIMIT` | `60` / `100` | 限速窗口（秒）与窗口内最大请求数 |
| `THROTTLE_STORAGE` | `memory` | 限速计数存储：`memory` 单进程（多副本时限额=limit×副本数）；`redis` 跨实例共享 |
| `CORS_ORIGIN` / `CORS_CREDENTIALS` | `*` / `false` | CORS 允许来源（`*` 或逗号分隔白名单）与是否允许携带凭证；生产必填 |
| `DB_HOST` / `DB_PORT` | `localhost` / `5432` | PostgreSQL 地址（dev compose 默认 `nest_app` / `pg_dev_password` / `nest_dev`） |
| `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE` | — | 数据库账号；生产密码必填且非空 |
| `DB_SSL` | `false` | 是否以 TLS 连接（托管数据库常要求） |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` | 是否校验证书链；指向外部托管数据库必须保持 `true`（`false` 仅限本地实验，MITM 风险） |
| `DB_SSL_CA` | 空 | CA 证书文件路径（PEM）；提供后强制 `rejectUnauthorized=true` |
| `DB_SYNCHRONIZE` | `false` | schema 自动同步；仅原型/测试可用，**生产设 `true` 会启动失败** |
| `DB_LOGGING` | `error` | SQL 日志：`false \| true/all \| query,schema,error,...` |
| `DB_POOL_MAX` / `DB_POOL_MIN` | `10` / `2` | 连接池上限 / 最小空闲 |
| `DB_POOL_IDLE_TIMEOUT_MS` / `DB_POOL_CONNECTION_TIMEOUT_MS` | `30000` / `10000` | 空闲回收 / 取连接超时（毫秒） |
| `DB_QUERY_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS` | `5000` / `4000` | 查询超时（毫秒，`0=禁用`）；服务端先终止（statement）再客户端兜底（query），要求 `statement < query` |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | Redis 地址（dev compose 默认密码 `redis_dev_password`） |
| `REDIS_PASSWORD` | 空 | 鉴权密码；空串仅限本机，生产必填非空 |
| `REDIS_DB` | `0` | 逻辑库编号 0-15 |
| `REDIS_KEY_PREFIX` | `nest:` | 键前缀（以 `:` 结尾），同实例多应用隔离 |
| `REDIS_COMMAND_TIMEOUT_MS` | `5000` | 单条命令超时（毫秒，`0=禁用`）；防依赖假死挂起调用方 |
| `JWT_SECRET` | 无默认值（开发兜底示例值） | JWT 签名密钥，**>=16 字符**；生产必填（缺失启动失败）。首尾空白自动去除（Joi 校验与 `jwtConfig` 工厂同源 trim，避免"校验通过但签名用未 trim 值"）。生成：`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `JWT_ACCESS_TTL_SECONDS` / `JWT_REFRESH_TTL_SECONDS` | `900` / `604800` | access token 有效期（秒，短 TTL 缩小泄露窗口）/ refresh token 有效期（秒，DB 存哈希，撤销即失效） |

**迁移专项**（仅 CLI / 生产 migrate 服务读取，不进入应用运行时）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DB_MIGRATION_LOCK_TIMEOUT_MS` | `10000` | 迁移锁等待超时（毫秒，`0=禁用`）；迁移不设 statement/query 超时（长 DDL 不应被中断），但锁等待必须有限，防止死锁永久挂起 |
| `DB_MIGRATION_TIMEOUT_SECONDS` | `600` | 整体部署超时（秒）；migrate 命令由 `timeout` 包装，超过即失败，避免异常 SQL 让部署无限等待 |

### 生产安全策略（启动校验，`NODE_ENV=production` 时强制）

1. `SWAGGER_ENABLED` 强制为 `false`（接口文档不暴露在生产）。
2. `DB_SYNCHRONIZE` 强制为 `false`（schema 变更只能走 migration）。
3. `DB_PASSWORD` / `REDIS_PASSWORD` 必填非空。
4. `TRUST_PROXY` 必填（显式声明代理层数或 `false`，不允许默认值静默上线）。
5. `CORS_ORIGIN` 必填（不允许默认通配 `*` 静默上线）；`CORS_CREDENTIALS=true` 时 `CORS_ORIGIN` 不得为 `*`。
6. 数据库超时顺序校验（任意环境）：`DB_STATEMENT_TIMEOUT_MS < DB_QUERY_TIMEOUT_MS`（均为 `0` 或单侧 `0` 时跳过比较）。
7. `JWT_SECRET` 必填且长度 >= 16（不允许默认示例密钥静默上线；缺省会启动失败）。

## 运行测试

单元测试与 e2e 测试均位于 `test/` 目录，目录结构与 `src/` 对应。

```bash
# 单元测试（28 suites · 309 tests）
$ pnpm run test

# e2e 测试（8 suites · 38 tests）——需要先 docker compose up -d 起依赖，
# 并对测试库执行迁移：pnpm run migration:run:test
# 注意：test:e2e 固定 --runInBand 串行执行（suite 间共享同一测试库，
# 并行时 8 个 app 实例并发写库会偶发瞬时超时/连接竞争导致 flaky 失败，串行消除）
$ pnpm run test:e2e

# 测试覆盖率（阈值：语句 65% / 分支 78% / 函数 60% / 行 65%，见 package.json）
$ pnpm run test:cov

# ESLint 仅检查（本地想自动修复用 pnpm run lint）
$ pnpm run lint:check
```

CI（`.github/workflows/ci.yml`，Node 24 + pnpm 12.4.2 + `--frozen-lockfile`）在 push/PR 时按顺序执行：

1. **audit**：生产依赖漏洞扫描（`pnpm audit --prod`；已记录的例外：glob CLI 公告仅影响 jest 开发链路，见工作流内注释）；
2. **lint**：仅检查（check-only，不做 `--fix`）+ 全量类型检查（`tsc --noEmit`，兜住 ts-jest 转译不查类型、build 排除 test 的盲区）；
3. **test**：单测 + 覆盖率门槛 + 覆盖率报告上传（artifact 保留 7 天）；
4. **build**：`pnpm run build`；
5. **e2e**：真实 PostgreSQL/Redis 容器 + **迁移路径**（`DB_SYNCHRONIZE=false`，与生产一致，先 `migration:run:test` 再启动应用）；
6. **docker-smoke**：`docker build` 生产镜像 + 以生产配置（无任何 `.env` 文件）启动容器，等待 `/api/health/ready` 就绪。

## 认证接口

认证模块位于 `src/modules/auth/`，注册/登录/刷新/登出四个开放端点 + 一个受保护端点。统一响应信封下，认证失败按 HTTP 语义返回状态码（401/403/409），成功一律 `code: 0`。

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/auth/register` | 开放 | 注册（用户名 + 密码，邮箱/手机号至少其一可选）；**201 + 空响应（不返回用户信息，/me 是唯一资料入口）**；用户名冲突返回 409；限速 5 次/分 |
| POST | `/api/auth/login` | 开放 | 登录（账号 = 用户名/邮箱/手机号任一，按标识形态路由到单字段查询：含 `@` → 邮箱、纯数字/+ 区号（6-20 位）→ 手机号、其余 → 用户名）；**返回令牌对（不含用户信息，/me 是唯一资料入口）**；失败统一 401；限速 5 次/分 |
| POST | `/api/auth/refresh` | 开放 | 刷新令牌对（旧 refresh token 轮换撤销，签发新对）；令牌从 Cookie 或 body 二选一；限速 10 次/分 |
| POST | `/api/auth/logout` | 开放 | 登出（撤销 refresh token + 清 Cookie，幂等——无令牌/已撤销不报错） |
| GET | `/api/auth/me` | `Authorization: Bearer <accessToken>` | 当前用户信息（示例受保护端点，`JwtAuthGuard`） |
| PATCH | `/api/auth/me` | `Authorization: Bearer <accessToken>` | 自助修改个人资料（昵称/性别/生日/头像；**登录标识与状态不可自助修改**，返回最新用户信息） |

### 双令牌方案（为什么这样设计）

| | access token | refresh token |
|---|---|---|
| 载体 | 响应体（客户端放内存） | **httpOnly Cookie**（`SameSite=Lax`、`Path=/api/auth`，覆盖整个认证前缀——收窄到 `/refresh` 会让浏览器登出时带不上 Cookie）+ 响应体同传（移动端无 Cookie 机制用 body 字段） |
| 有效期 | 15 分钟（`JWT_ACCESS_TTL_SECONDS`） | 7 天（`JWT_REFRESH_TTL_SECONDS`） |
| 存储 | 无状态（JWT 载荷仅 `sub` + `sessionVersion`——版本号供踢出/禁用即时失效比对，不存库） | DB 只存 **SHA-256 哈希**（`refresh_tokens` 表），明文仅签发时返回一次 |
| 撤销 | 天然过期（短 TTL）**+ 即时封禁**（`JwtAuthGuard` 每个受保护请求查库复查用户状态——账号被禁用/删除后旧 access 令牌立即失效，不依赖 TTL 过期） | 刷新即轮换（旧令牌写 `revokedAt`），登出/重放检测即时失效 |

要点：access token 短命且无状态，泄露窗口小；refresh token 进 httpOnly Cookie（JS 无法**直接读取** Cookie），路径限定在刷新端点减少暴露面；每次刷新都轮换，已被使用过的旧令牌再次出现一律 401（防重放）。**注意响应体同时回传明文 refresh token（移动端/无 Cookie 客户端契约）——HttpOnly 防的是"JS 读 Cookie"，XSS 脚本仍可主动调用刷新接口并从 JSON 响应读取新令牌**；浏览器端前端代码应忽略该字段（不读取、不存储），真正防线是同源策略 + 无 CORS 暴露 + CSP（见[已知取舍](#已知取舍)）。轮换的"撤销旧令牌 + 落库新令牌"在**单个数据库事务**内原子完成——新令牌落库失败（如数据库抖动）时整体回滚，旧令牌保持有效可重试，不会出现"旧令牌已撤销、新令牌未落库"而被迫重新登录。

### 安全设计

- **密码**：bcrypt 哈希（cost 10），不存盐（bcrypt 盐内嵌于哈希串）。**无密码账号（`password_hash` 为 NULL，第三方登录通道预留）不可用密码登录**——即便口令恰好是固定哑哈希的明文，也因 `password_hash` 为空被显式拒绝。
- **防枚举**：登录失败统一"账号或密码错误"（响应层再统一为"未登录或登录已失效"的 401 文案）；注册冲突不区分具体字段；用户不存在/无密码账号也执行假密码比对，避免响应时长泄露账号是否存在；登录超长口令（>72 字节，bcrypt 截断上限）同样统一 401 而非顶部抛 400——快速 400 会泄露处理路径差异。
- **即时封禁**：`JwtAuthGuard` 每个受保护请求查库复查用户状态（与 refresh 链路同语义）——账号被禁用/软删后，已签发的 access 令牌立即失效，无需等待 15 分钟 TTL 自然过期。
- **限速**：注册/登录 5 次/分、刷新 10 次/分（`@Throttle` 装饰器，计数存储随 `THROTTLE_STORAGE` 切换）。
- **日志**：登录成功/失败/注册写结构化 pino 日志（`event: auth.login.success/failed/register`，含 userId/IP/UA）；登录三态（成功/凭据错/账号禁用）同时落 `login_logs`（账号脱敏、尽力而为写入，见下文"审计"小节）。

## RBAC 权限体系

模块位于 `src/modules/rbac/`，四张表 + 声明式守卫，提供"角色 → 权限"两级授权：

| 表 | 说明 |
|---|---|
| `roles` | 角色（`code` 唯一）；`is_system` 标记系统内置角色 |
| `permissions` | 权限点（`code` 唯一，命名如 `user:delete`） |
| `user_roles` | 用户-角色关联（`userId` + `roleId` 复合唯一） |
| `role_permissions` | 角色-权限关联（`roleId` + `permissionId` 复合唯一） |

种子（迁移 `InitRbac` 幂等插入，`is_system=true`）：`admin`（超管，**旁路**：拥有任意角色即拥有全部权限，新权限点无需手动分配给超管）与 `user`（普通用户，**注册不自动分配**，由管理员按需分配）。系统角色不允许修改/删除（管理端接口落地时校验）。

### 用法

```ts
// 控制器：声明式授权（RolesGuard 与 JwtAuthGuard 配合，先认证后授权）
@UseGuards(JwtAuthGuard, RolesGuard)
@Get('admin-only')
@Roles('admin')                 // 或 @Permissions('user:delete')
adminOnly() { return { ok: true }; }
```

- `@Roles('admin')`：用户拥有该角色码即放行（任一命中即可，多角色用数组）。
- `@Permissions('user:delete')`：用户任意角色绑定了该权限码即放行（admin 旁路）。
- `/api/auth/me` 返回 `roles: string[]` 与 `permissions: string[]`（admin 为全量权限码），供前端做菜单/按钮级控制。

### 管理端接口

角色 / 权限 / 用户分配（全部需登录 + 权限点授权；`admin` 旁路自动拥有全部）：

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/api/roles` | `role:read` | 角色列表（含权限码） |
| POST | `/api/roles` | `role:create` | 创建角色（code 唯一，冲突 409） |
| PATCH | `/api/roles/:id` | `role:update` | 改名称/描述（**code 不可改**——它是 `@Roles` 的代码引用；系统角色 403） |
| DELETE | `/api/roles/:id` | `role:delete` | 删除（系统角色 403；仍有关联用户 409） |
| PUT | `/api/roles/:id/permissions` | `role:assign-permission` | 整体替换角色权限（系统角色 403） |
| GET | `/api/permissions` | `role:read` | 权限点列表（只读，按分组） |
| GET | `/api/users` | `user:read` | 用户分页列表（含角色码）（UsersModule） |
| POST | `/api/users` | `user:create` | 创建用户（管理员代建；校验/规范化/哈希与注册一致，创建后即可登录；标识冲突 409）（UsersModule） |
| PATCH | `/api/users/:id` | `user:update` | 更新用户资料（昵称/姓名/性别/生日/头像/备注；**不含登录标识与状态**）（UsersModule） |
| PATCH | `/api/users/:id/status` | `user:disable` | 修改状态 active/disabled/banned；**非 active 即撤销该用户全部活跃会话**（UsersModule） |
| PUT | `/api/users/:id/roles` | `user:assign-role` | 整体替换用户角色（空数组 = 清空）（UsersModule） |

会话管理（在线列表 + 强制下线；SessionsModule，权限点 `session:read` / `session:revoke`）：

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/api/sessions` | `session:read` | 在线会话分页列表（`page`/`pageSize`/`userId`/`username` 筛选；"在线" = refresh 行未撤销且未过期） |
| DELETE | `/api/sessions/:id` | `session:revoke` | 强制下线单个会话（撤销该 refresh 行；不存在/已下线 404） |
| DELETE | `/api/users/:id/sessions` | `session:revoke` | 强制下线某用户全部会话（撤销全部 + `session_version` +1 → 旧 access 即时失效） |

要点：
- **"在线"的定义**：access token 是无状态 JWT，服务端不追踪；`refresh_tokens` 活跃行（`revoked_at IS NULL` 且 `expires_at > now`）是唯一可靠的会话载体——登录落库、刷新轮换、登出/下线写撤销时间；
- **两段式踢出**：撤销 refresh 行让"刷新"立即失效；递增 `session_version`（已签进 access payload，`JwtAuthGuard` 每请求比对）让旧 access **即时**失效（不等 15 分钟窗口）——两者在同一事务内，缺一不可（只撤销会留 access 窗口，只递增会留下可刷新的会话）；
- **能力边界（单会话下线）**：`DELETE /api/sessions/:id` 走"最小影响"取舍——只撤销该会话的 refresh 行、**不**递增 `session_version`，因此该用户**已签发的 access token 仍存活最长 15 分钟**（无状态 JWT 窗口）。只有"全部下线"（`/api/users/:id/sessions`）即时掐断 access。若产品期望"单会话下线也即时失效"，需改为递增版本号（代价：同一用户其他会话的 access 一并失效），当前实现不支持；
- **软删用户的会话**：`list` 的 join 对带 `@DeleteDateColumn` 的用户自动追加 `deleted_at IS NULL`，软删用户的活跃会话**不出现在**在线列表（TypeORM 语义，已有 e2e 钉死防升级漂移）；其刷新链路也已被 `refresh` 的用户查询过滤拦截（401）。软删是 UPDATE、不触发 `refresh_tokens` 的 DB 级 CASCADE，残留行由登录惰性清理按过期收敛；
- **登录惰性清理**：登录成功时顺带删除该用户已过期行（不删未过期的撤销行——"已轮换令牌再次出现"的盗用检测依赖撤销记录），零额外依赖地遏制 `refresh_tokens` 只增不清；清理为尽力而为（失败仅记 warn，不阻断登录）；
- **踢出与刷新的并发安全**：`auth.refresh` 轮换与"全部下线"都以**锁用户行**（SELECT ... FOR UPDATE）为事务前置，两者完全串行——不存在"全部下线提交后，刷新事务插入的新 refresh 行复活会话"的竞态（两种交错都收敛：刷新先提交则批量撤销覆盖新行；全部下线先提交则刷新 CAS 401）；
- **降级防护（与 users 管理同口径）**：非 admin 操作者**不得下线持有 admin 角色的账号**（403，见 `common/utils/admin-guard.ts` 单一真源）——防止持 `session:revoke` 的人反复踢管理员的骚扰级 DoS；admin 旁路不受限；
- 列表项为显式投影字段，`tokenHash` 绝不外泄。

审计（AuditModule，权限点 `audit:read`；只读查询接口）：

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/api/audit/login-logs` | `audit:read` | 登录日志分页（`page`/`pageSize`/`success` 筛选，按时间倒序） |
| GET | `/api/audit/logs` | `audit:read` | 管理操作审计分页（`page`/`pageSize`/`action`/`operatorId`/`resourceType` 筛选，按时间倒序） |

设计要点：
- **登录日志（login_logs）**：每次登录三态（成功 / 凭据错 / 账号禁用）落一行——`account` 一律经 `maskAccount` 脱敏（邮箱 `a***@dom`、手机号只留首尾、用户名原样），**不落 PII 明文**；写入前按列宽裁剪（`account`/`user_agent` 255、`ip` 45）——超长 UA 若任其触发 `22001` 会被“尽力而为”吞掉，导致该次登录完全不留痕（审计被绕过）；`user_id` SET NULL 外键（用户删除后日志保留审计价值）；`fail_reason` 记 `invalid_credentials` / `account_disabled`；
- **操作审计（audit_logs）**：覆盖管理写路径（users 创建/改资料/改状态/分配角色、rbac 角色 CRUD/分配权限、sessions 单/全部下线），动作码点分命名（`user.create` / `role.update` / `session.revoke_all`）且集中定义于 `src/common/constants/audit.constants.ts`（`AUDIT_ACTIONS`，代码侧唯一真源，与权限码 `PERMISSION_CODES` 同惯例）；`resource_type` 只取 `user` / `role` / `session`——注意 `session.revoke_all` 记 `user`（`resource_id` 是被踢的用户 ID 而非会话 ID）；`detail` 只存变更摘要（状态 from→to、roleIds、code 等），**禁止敏感字段**；`operator_id` SET NULL 外键；`ip` 由 controller 透传 `req.ip` 落库（特权操作可溯源来源 IP）；
- **尽力而为写入**：写入失败只记 warn、**绝不抛出**——登录已返回/管理操作已生效，审计是旁路，失败不得让主流程 500/回滚（与登录惰性清理同口径）；写入方在调用模块（auth 自持 LoginLog 仓库、经本模块 `recordLoginLog` 写入；users/rbac/sessions 经 AuditService），AuditModule 只读查询，避免 AuthModule↔AuditModule 循环依赖；登录日志不再经 AuditService（曾与 auth 各持一份重复实现、且测试覆盖的是不被调用的那份死代码，已删除）；
- **查询层无需二次脱敏**：库中已是脱敏值；分页 pageSize 上限 100、page 上限 1_000_000（防 `(page-1)*pageSize` 溢出 bigint 触发 PG `22003` → 500）。

要点：
- **模块归属**：`/api/users*` 归 UsersModule（用户资源上的管理操作：列表/创建/资料/状态/角色分配），
  RbacModule 只管 `/roles`、`/permissions` 与角色-权限绑定；权限点常量仍在 `rbac.constants.ts`（代码侧唯一真源）；
- **改状态即终止会话**：`PATCH /api/users/:id/status` 置为非 active 时，服务层**在同一事务内**递增 `session_version` + 撤销该用户全部活跃 refresh token（`revokedAt` 条件更新，幂等）——"禁用"是终止会话而非暂停：旧 access 因版本失配**永久失效**（仅撤销 refresh 会在恢复 active 后让旧 JWT 重新通过校验），恢复后必须重新登录；恢复 active 不递增（旧令牌反正已失效）；
- **权限点不做 CRUD，只做登记与展示**：权限点由代码声明（`PERMISSION_CODES` 常量 + `@Permissions` 引用），管理端只能读列表给角色分配——新增权限点 = 常量加一行 + 迁移种子加一行（见 `InitRbacPermissions`），避免"动态权限点"与代码脱节（建了没人用 / 删了守卫悬空）；
- **系统角色完全只读**：`is_system=true`（admin/user）PATCH/DELETE/改权限一律 403——改 code 会破坏 `@Roles('admin')` 引用，改权限绑定与守卫旁路语义冲突；
- **分配用整体替换**（先清后插，同一事务）：空数组 = 清空，不出现增量增删的状态漂移；
- **提权防护（管理权限不能自我提升）**：分配角色/权限的目标必须是**操作者自己已有集**的子集
  （admin 旁路例外）——持有 `user:assign-role` 的人不能把 admin 角色分配给自己/他人，
  持有 `role:assign-permission` 的人不能给自己所在角色绑它没有的权限点；
  操作者集合即时查库（与"每请求查库"模型一致），不依赖令牌内快照；
- **降级防护（内部人不能锁死系统）**：非 admin 操作者不得变更持有 admin 角色的账号（角色/状态）；
  **最后 admin 保护**——admin（旁路）也不能移除/禁用**唯一活跃管理员**（403「不能移除最后一个管理员」），
  防止管理员被清空后系统无人可管；判定与变更在**同一事务**内执行，并以 `SELECT ... FOR UPDATE`
  锁 admin 角色行——两个 admin 并发互移/互禁时串行化，后到者读到变更后的真实数量（防竞态锁死）；
- **管理端遵循 REST 语义**（404/403/409），与认证端"HTTP 200 + 业务码"刻意区分——内部工具需要精确的状态语义。

### 设计要点

- **每请求查库 → 即时生效**：`JwtAuthGuard` 每请求复查用户状态，`RolesGuard` 每请求查角色/权限，不做 JWT 角色快照。管理员改角色/权限后**同一 access token 立即生效**（最长 15 分钟 TTL 的会话无需重新登录）；代价是每个权限接口多 2–3 条主键/关联查询（普通接口零增加——`JwtAuthGuard` 按 handler 元数据决定是否预加载 RBAC 关系）。
- **踢人已落地**：`session_version` 签进 access payload，`JwtAuthGuard` 每请求比对；`DELETE /api/users/:id/sessions` = 撤销全部活跃 refresh + 版本 +1（同一事务），旧 access 即时失效（见上文会话管理小节与[已知取舍](#已知取舍)）。
- **审计口径**：`users` 表的用户名/邮箱/手机号是**局部唯一索引**（软删行不占标识但旧行保留），管理端/客服按标识查用户必须显式带 `deleted_at IS NULL`，写操作一律以主键 `id` 定位（避免命中历史软删行）。

## 数据层与迁移

- **PostgreSQL**：主数据库，经 `@nestjs/typeorm`（TypeORM）连接，配置在 `src/config` 的 `database` 命名空间（`DB_*` 变量）。实体通过特性模块 `TypeOrmModule.forFeature([...])` 注册（示例见 `src/modules/auth/auth.module.ts` 的 User / RefreshToken）。
- **Redis**：全局缓存层（`src/redis` 的 `RedisService`，JSON 序列化 + 键前缀 + 失败降级），同时承载限速计数存储（`THROTTLE_STORAGE=redis`，多副本共享限额）。
- **迁移**：CLI 与运行时共用 `src/database/data-source.ts` → `buildTypeOrmOptions`，保证两侧配置一致（迁移场景 statement/query 超时显式置 0，避免长 DDL 被中断，锁等待与整体部署超时由专项变量控制）。

### 两套环境怎么选（新手先看这里）

项目里有 **两套 Docker 编排**，用途不同，不要混用：

| | 开发（日常写代码用这套） | 生产（模拟线上部署时才用） |
|---|---|---|
| 编排文件 | 根目录 `docker-compose.yml` | `docker/docker-compose.prod.yml` |
| 容器里跑什么 | 只有 postgres + redis | 应用 + migrate + postgres + redis 全套 |
| 应用在哪跑 | 你自己的电脑：`pnpm start:dev`（热重载） | 容器里，改代码要 `--build` 重建镜像 |
| 凭证从哪来 | 根目录 `.env`（弱密码，仅本地） | `docker/.env.prod`（强密码，缺失即拒绝启动） |
| 启动 | `docker compose up -d` | `pnpm docker:prod` |
| 停止 | `docker compose down` | `docker compose -f docker/docker-compose.prod.yml down` |
| 访问入口 | `http://localhost:3000/api`（宿主机应用） | `http://localhost:3000/api`（compose 映射，默认仅本机回环） |
| 数据库端口 | 5432/6379 对宿主开放，方便本地连工具 | 不对宿主开放，只有容器内网可达 |

涉及的 env 文件各管各的，一句话区分：

```text
.env                  根目录。应用自己读的总配置；dev compose 也顺手从这取凭证起库
.env.test             跑测试时覆盖 .env（nest_test 库、限速走 memory）
docker/.env.prod      只给"生产 compose 插值"用，应用不读它；
                      里面的值经 environment: 注入容器进程，不进镜像
```

> 注意：两套栈同时运行时都占宿主 3000 端口。若生产容器已启动，本地 `pnpm start:dev`
> 会端口冲突——先 `docker compose -f docker/docker-compose.prod.yml down`，
> 或给生产改 `APP_HOST_PORT=3001`（见 `docker/.env.prod`）。
> 两套的容器名、数据卷相互独立（`nest-backend-*` vs `nest-backend-prod-*`），互不影响。

### Migration 工作流

仓库已有八个迁移（见 `src/database/migrations/`）：**`InitAuth`**（`users` + `refresh_tokens` 表）、**`InitRbac`**（`roles` / `permissions` / `user_roles` / `role_permissions` 四表 + 种子角色 `admin` / `user`，幂等插入）、**`InitRbacPermissions`**（管理端 7 个权限点种子：`role:read` / `role:create` / `role:update` / `role:delete` / `role:assign-permission` / `user:read` / `user:assign-role`，幂等插入）、**`InitUserPermissions`**（用户管理 3 个权限点：`user:create` / `user:update` / `user:disable`，幂等插入）与 **`InitSessionPermissions`**（会话管理 2 个权限点：`session:read` / `session:revoke`，幂等插入）、**`InitAudit`**（`login_logs` + `audit_logs` 两表及索引，`user_id` / `operator_id` 均 SET NULL 外键——用户删除后审计保留）、**`InitAuditPermissions`**（审计 1 个权限点：`audit:read`，幂等插入）与 **`InitPaginationIndexes`**（用户/在线会话列表的 `(created_at, id)` 稳定分页排序索引，幂等创建）。权限点合计 **13** 个；
用户名/邮箱/手机号的唯一性用**局部唯一索引**（`WHERE deleted_at IS NULL`，软删行不占用标识——注销后标识可重新注册）；
`DB_SYNCHRONIZE` 已全面关闭（`.env` / `.env.test` / 生产均 `false`），schema 变更一律走迁移。新增/修改实体后：

```bash
# 修改实体后生成迁移（对比实体与数据库 schema，只产出差异 SQL）
$ pnpm run migration:generate src/database/migrations/XxxDescription
# 执行 / 回滚最近一次
$ pnpm run migration:run
$ pnpm run migration:revert
# e2e 前对测试库（NODE_ENV=test → .env.test 的 nest_test）执行迁移
$ pnpm run migration:run:test
```

> 注意：`migration:generate` 与 `migration:run` 走 `NODE_ENV=development`（连 `.env` 的 `nest_dev` 库），
> e2e 走测试库 `nest_test`。CI 的 e2e 在 `DB_SYNCHRONIZE=false` 下先 `migration:run:test` 再启动应用，
> 保证每次提交都真实验证迁移路径。

## 健康检查与可观测性

三类健康语义（均不限速）：

| 端点 | 语义 | 用途 |
|------|------|------|
| `GET /api/health/live` | 进程存活（不探测依赖） | 容器 `HEALTHCHECK` 用它判活——依赖故障不应触发重启 |
| `GET /api/health/ready` | 依赖就绪（数据库 `SELECT 1` + Redis `PING`，各带 2s 超时） | 负载均衡/发布流程摘流；任一依赖不可用返回 503 |
| `GET /api/health` | ready 的兼容别名（历史契约） | 兼容旧客户端 |

统一响应结构（成功与失败同构）：`{ code, message, data, path, timestamp }`。

- `code`：业务码，`0` 成功；业务失败由 `BusinessException` 携带（HTTP 200 + 业务码，国内惯例），其余异常按 HTTP 语义返回（4xx/5xx）。
- 错误响应带 `Cache-Control: no-store`，且业务失败会输出 `X-Business-Code` 响应头 + warn 级日志，弥补 HTTP 200 无法被监控直接识别的缺陷。
- `X-Request-Id`：由 pino `genReqId` 统一生成/回写，日志 `req.id` 与响应头同源，支持排障关联（实现见 `src/common/utils/request-id.ts`）。

## 项目规范

- **代码注释**：统一遵循 [COMMENT_STYLE.md](./COMMENT_STYLE.md)（注释风格、JSDoc 格式、避免冗余清单、提交前检查项；`src/` 下所有代码强制遵守）。
- **路径别名**：`@/` 指向 `src/`，例如 `import { AppModule } from '@/app.module'`。
- **导入排序**：由 ESLint（`eslint-plugin-simple-import-sort`）自动整理，运行 `pnpm lint` 修复。
- **测试目录**：所有测试文件统一放在 `test/` 目录下，目录结构与 `src/` 对应。
- **业务异常约定**：`BusinessException` 固定返回 HTTP 200 + 响应体业务 `code`（国内业务码惯例）。可观测性已补偿：响应头 `X-Business-Code` + 过滤器 warn 级日志；错误响应一律 `Cache-Control: no-store`，接入 CDN 时仍请复查。
- **应用装配**：全局管道/前缀/CORS/helmet/Swagger 统一在 `src/app.setup.ts` 的 `configureApp` 中挂载，`main.ts` 与 e2e 共用；全局过滤器/守卫/拦截器在 `app.module.ts` 的 providers 中注册。

## 部署

### 开发环境（Docker 起依赖，应用跑宿主机）

```bash
$ cp .env.example .env          # 按需修改；默认凭证与 docker-compose.yml 一致
$ docker compose up -d          # 启动 postgres + redis（含健康检查与数据卷）
$ pnpm run start:dev
```

### 生产环境（整栈容器化）

`docker/docker-compose.prod.yml` 编排 应用 + migrate 一次性任务 + PostgreSQL + Redis：
数据库/Redis 不对宿主暴露端口，凭证经 `--env-file` 注入、不进镜像层，
`migrate` 成功后应用才启动，三个服务间用 healthcheck 串联。

```bash
$ cp docker/.env.prod.example docker/.env.prod   # 填写强密码（已 gitignore）
$ docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod config   # 先校验
$ docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod up -d --build
```

> 注意：构建产物 `dist/main.js` 在运行时会读取项目根目录的 `package.json`（Swagger 版本号），打包制品时请保证 `dist/` 与根 `package.json` 一同发布。

## API 文档

开发环境启用 Swagger 后访问 `/api/docs`（受保护端点如 `/api/auth/me` 带 🔒 标记：点击页面右上角 **Authorize** 按钮，粘贴 `Authorization: Bearer <accessToken>` 后可在线调试）：

```bash
# .env 中设置 SWAGGER_ENABLED=true 后重启
$ pnpm run start:dev
# 打开 http://localhost:3000/api/docs
```

> 生产环境 `SWAGGER_ENABLED` 被启动校验强制为 `false`，接口文档不会暴露。

**通用接口约定**（属于基本认知，不在每个端点的 Responses 区重复标注）：

- `401`：所有受保护接口（挂 `JwtAuthGuard`）在未携带令牌或令牌失效时返回，登录失败同样统一 401（文案不分"账号不存在/密码错误"，防枚举）。
- `429`：触发限速时返回。全局窗口由 `THROTTLE_TTL` / `THROTTLE_LIMIT` 配置；认证接口另有接口级收紧（注册/登录 5 次/分、刷新 10 次/分）。
- Swagger 每个端点的 Responses 区只标注**接口特有**的状态码与响应体形状（成功信封 + `data` 结构、注册的 `409` 等），通用 401/429 见本节。

## 已知取舍

- **许可证**：`package.json` 声明 **UNLICENSED**（内部/私有模板，保留所有权利，无 LICENSE 文件）；复制/分发前请先与项目所有者确认授权。底层框架 [Nest](https://github.com/nestjs/nest) 采用 [MIT 许可证](https://github.com/nestjs/nest/blob/master/LICENSE)。
- **业务异常 HTTP 200**：为保证国内业务码惯例与历史契约，业务失败不映射 4xx/409；可观测性已用响应头 + 日志补偿。若未来需要严格 REST 语义，属破坏性变更，需统一评估。
- **Swagger 响应装饰器**：共享工厂在 `src/common/swagger/api-response.decorator.ts`（`ApiOkEnvelope` / `ApiCreatedEnvelope` / `ApiConflictResponse`），统一信封已文档化到认证端点的 Responses；401/429 属通用契约（见「通用接口约定」）不在每个端点标注。新增业务端点时复用成功装饰器 + 接口特有失败装饰器。
- **登录标识按形态路由**：登录时账号按形态判定为邮箱（含 `@`）/手机号（纯数字或 `+` 区号开头，6-20 位）/用户名（其余）后单字段查询——避免"某标识同时是 A 的用户名与 B 的手机号"时 OR 查询命中多行、绑定不可预期。由于 6-20 位纯数字会被当作手机号，注册校验已直接拒绝这类用户名。注册端仍有跨字段冲突检查 + 唯一索引兜底。
- **refresh token 响应体回传（双通道契约）**：HttpOnly Cookie 是浏览器通道；响应体同时回传明文 refresh token 供移动端/无 Cookie 客户端使用。代价：存在 XSS 时，脚本可调用刷新接口并从 JSON 响应读取新令牌（HttpOnly 只阻止"直接读 Cookie"）。缓解：前端代码不得读取/存储该字段、CORS 收紧（不暴露接口给第三方源）、CSP 降低注入面。若确认只服务浏览器，可在 `auth.controller.ts` 的 `setRefreshCookie` 后不返回 `refreshToken` 字段并移除 body 通道（`RefreshDto.refreshToken` 随之弃用）——属破坏性契约变更，需统一评估。
- **refresh token 轮换并发**：同一 refresh token 被并发请求共用时，后到者必然 401（旧令牌已被轮换撤销，CAS 保证）。前端刷新需做 single-flight（合并并发刷新请求为一次）；无宽限期的选择是刻意的——可降低令牌被盗重放的窗口。
- **refresh_tokens 收敛**：登录成功时惰性删除该用户已过期行（只按过期收敛，未过期的撤销行保留——盗用检测依赖）；已撤销但未过期的行仍只靠 7 天 TTL + `idx_refresh_tokens_expires` 索引兜底，未挂 cron；同一用户会话数无上限（在线列表分页查看）。
- **密码哈希用原生 `bcrypt`（非 bcryptjs）**：bcryptjs 是纯 JS 实现，同 cost 下比原生慢数倍且全部计算占用主线程（其"异步"是分片让出式）；原生 `bcrypt` 走 libuv 线程池，主线程几乎零负担。代价是原生依赖：`pnpm` 需在 `pnpm-workspace.yaml` 的 `allowBuilds` 放行其构建脚本，Docker 镜像依赖官方 musl prebuilt。`argon2` 是更现代的 KDF（内存硬、抗 GPU/ASIC），若未来需要可迁移。
- **开发环境默认弱密码**（`pg_dev_password` / `redis_dev_password`）：仅存在于 dev compose 与 `.env.example`，生产模板要求强密码且缺失即拒启。
- **会话版本号（踢出即时生效）**：`users.session_version`（默认 0）签进 access payload，`JwtAuthGuard` 每请求比对（与现有"每请求复查用户状态"同一次查库），不一致即 401。强制下线 = 版本 +1，该用户所有已签发 access token 立即失效（无状态 JWT 无法主动撤销，靠版本比对实现即时生效）；旧实现签发的令牌无此字段（undefined ≠ 当前版本）→ 一律重新登录，开发期无存量令牌，无兼容成本。
- **首个发布前迁移允许就地改写**：`InitAuth` 在首个发布前被就地改写（局部唯一索引），因为确认没有任何持久环境应用过旧版；**此后 schema 变更必须追加新迁移**，且 `migration:revert` 只对当前 DDL 有效——不要修改已提交/已应用过的迁移文件。

## 相关资源

- [NestJS 官方文档](https://docs.nestjs.com) | [TypeORM 文档](https://typeorm.io) | [pino 文档](https://getpino.io)
- 遇到问题可加入 [NestJS Discord](https://discord.gg/G7Qnnhy) 或查看官方[视频课程](https://courses.nestjs.com/)
- 需要项目支持（兼职到全职），可了解官方[企业支持服务](https://enterprise.nestjs.com)

## 许可证

内部/私有模板，`package.json` 声明 **UNLICENSED**（保留所有权利，未开源，无 LICENSE 文件）；复制/分发前请先与项目所有者确认授权。
