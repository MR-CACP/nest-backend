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
- [数据层与迁移](#数据层与迁移)
- [健康检查与可观测性](#健康检查与可观测性)
- [项目规范](#项目规范)
- [部署](#部署)
- [API 文档](#api-文档)
- [已知取舍](#已知取舍)
- [许可证](#许可证)

---

## 项目简介

面向新手学习与二次开发的 NestJS 后端模板。默认只提供**基础设施能力**（配置、日志、限速、统一响应、健康检查、数据库/缓存接入），业务模块（认证、RBAC 等）按需在 `src/modules/` 下扩展。

## 核心特性

- **分层配置**：`.env` + `.env.{NODE_ENV}` 两级加载，Joi 启动校验，内置 6 条生产安全策略（见[环境变量](#环境变量)）。
- **结构化日志**：pino（nestjs-pino），自动请求关联 ID（`X-Request-Id` 与日志 `req.id` 同源），敏感请求头脱敏。
- **统一响应**：成功/失败共用 `{ code, message, data, path, timestamp }` 结构，由全局拦截器与异常过滤器保证。
- **业务异常契约**：`BusinessException` 返回 HTTP 200 + 业务码（国内业务码惯例），`X-Business-Code` 响应头 + warn 日志补偿可观测性。
- **限速**：`@nestjs/throttler`，计数存储可切换内存 / Redis（多副本共享）。
- **数据层**：TypeORM（PostgreSQL）连接池、SSL/超时/迁移专项配置；Redis 缓存门面（JSON 序列化 + 键前缀 + 失败降级）。
- **健康检查**：`/health/live`（进程存活）与 `/health/ready`（依赖就绪，各 2s 超时）分离，容器探针语义正确。
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
│   └── interceptors/        # TransformInterceptor（成功响应包装）
├── config/                  # types（类型定义）/ env.validation（Joi 校验 + 安全策略）/ configuration（命名空间工厂）
├── database/                # database.module（运行时连接）/ data-source.ts（TypeORM CLI 迁移专用）
├── redis/                   # redis.service（缓存门面）/ redis.module（客户端构建，超时选项纯函数）
└── health/                  # health.controller（live/ready/check）+ health.module

test/                        # 测试目录，结构与 src/ 对应（12 单测 suite + 2 e2e suite）
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

## 运行测试

单元测试与 e2e 测试均位于 `test/` 目录，目录结构与 `src/` 对应。

```bash
# 单元测试（12 suites · 120 tests）
$ pnpm run test

# e2e 测试（2 suites · 5 tests）——需要先 docker compose up -d 起依赖，
# 并对测试库执行迁移：pnpm run migration:run:test
$ pnpm run test:e2e

# 测试覆盖率（阈值：语句 65% / 分支 78% / 函数 60% / 行 65%，见 package.json）
$ pnpm run test:cov

# ESLint 仅检查（本地想自动修复用 pnpm run lint）
$ pnpm run lint:check
```

CI（`.github/workflows/ci.yml`，Node 24 + pnpm 12.4.2 + `--frozen-lockfile`）在 push/PR 时按顺序执行：

1. **audit**：生产依赖漏洞扫描（`pnpm audit --prod`；已记录的例外：glob CLI 公告仅影响 jest 开发链路，见工作流内注释）；
2. **lint**：仅检查（check-only，不做 `--fix`）；
3. **test**：单测 + 覆盖率门槛 + 覆盖率报告上传（artifact 保留 7 天）；
4. **build**：`pnpm run build`；
5. **e2e**：真实 PostgreSQL/Redis 容器 + **迁移路径**（`DB_SYNCHRONIZE=false`，与生产一致，先 `migration:run:test` 再启动应用）；
6. **docker-smoke**：`docker build` 生产镜像 + 以生产配置（无任何 `.env` 文件）启动容器，等待 `/api/health/ready` 就绪。

## 数据层与迁移

- **PostgreSQL**：主数据库，经 `@nestjs/typeorm`（TypeORM）连接，配置在 `src/config` 的 `database` 命名空间（`DB_*` 变量）。实体通过特性模块 `TypeOrmModule.forFeature([...])` 注册（示例见后续认证/RBAC 模块）。
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

仓库当前**尚无迁移文件**（`src/database/migrations` 为空目录，git 不跟踪空目录）；模板默认 `DB_SYNCHRONIZE=false`，本地原型期如需自动建表，把 `.env` 的 `DB_SYNCHRONIZE` 改为 `true`（生产环境为 true 会直接启动失败）。需要固化变更时：

```bash
# 修改实体后生成迁移（对比实体与数据库 schema，只产出差异 SQL；TypeORM 自动创建目录）
$ pnpm run migration:generate src/database/migrations/XxxDescription
# 执行 / 回滚最近一次
$ pnpm run migration:run
$ pnpm run migration:revert
# e2e 前对测试库（NODE_ENV=test → .env.test 的 nest_test）执行迁移
$ pnpm run migration:run:test
```

生成首个迁移后，把 `.env` / `.env.test` 的 `DB_SYNCHRONIZE` 改回 `false`，之后一律走 migration。

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

开发环境启用 Swagger 后访问 `/api/docs`：

```bash
# .env 中设置 SWAGGER_ENABLED=true 后重启
$ pnpm run start:dev
# 打开 http://localhost:3000/api/docs
```

> 生产环境 `SWAGGER_ENABLED` 被启动校验强制为 `false`，接口文档不会暴露。

## 已知取舍

- **许可证**：`package.json` 声明 **UNLICENSED**（内部/私有模板，保留所有权利，无 LICENSE 文件）；复制/分发前请先与项目所有者确认授权。底层框架 [Nest](https://github.com/nestjs/nest) 采用 [MIT 许可证](https://github.com/nestjs/nest/blob/master/LICENSE)。
- **业务异常 HTTP 200**：为保证国内业务码惯例与历史契约，业务失败不映射 4xx/409；可观测性已用响应头 + 日志补偿。若未来需要严格 REST 语义，属破坏性变更，需统一评估。
- **Swagger 响应装饰器**：当前无业务端点，接口文档只描述请求形状，统一响应信封未加 `@ApiResponse` 装饰器；落地真实端点时建议加共享装饰器。
- **开发环境默认弱密码**（`pg_dev_password` / `redis_dev_password`）：仅存在于 dev compose 与 `.env.example`，生产模板要求强密码且缺失即拒启。

## 相关资源

- [NestJS 官方文档](https://docs.nestjs.com) | [TypeORM 文档](https://typeorm.io) | [pino 文档](https://getpino.io)
- 遇到问题可加入 [NestJS Discord](https://discord.gg/G7Qnnhy) 或查看官方[视频课程](https://courses.nestjs.com/)
- 需要项目支持（兼职到全职），可了解官方[企业支持服务](https://enterprise.nestjs.com)

## 许可证

内部/私有模板，`package.json` 声明 **UNLICENSED**（保留所有权利，未开源，无 LICENSE 文件）；复制/分发前请先与项目所有者确认授权。
