<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

  <p align="center">用于构建高效、可扩展的服务端应用的渐进式 <a href="http://nodejs.org" target="_blank">Node.js</a> 框架。</p>

## 项目简介

基于 [Nest](https://github.com/nestjs/nest) 框架的 TypeScript 后端项目。

## 环境准备

```bash
$ pnpm install
```

## 编译与运行

```bash
# 开发模式
$ pnpm run start

# 监听模式（自动重启）
$ pnpm run start:dev

# 生产模式
$ pnpm run start:prod
```

## 运行测试

单元测试与 e2e 测试均位于 `test/` 目录。

```bash
# 单元测试
$ pnpm run test

# e2e 测试
$ pnpm run test:e2e

# 测试覆盖率
$ pnpm run test:cov
```

## 环境变量约定

- 配置通过 `.env`（基础值）+ `.env.{NODE_ENV}`（环境覆盖）加载，完整模板见 `.env.example`。
- **`NODE_ENV` 必须由进程环境注入**：`package.json` scripts 已通过 `cross-env` 写入，生产部署由部署平台注入。不要写在 `.env.*` 文件里——加载哪个环境文件本身取决于该变量，属于循环依赖，实际无效。
- 敏感信息（密钥、密码）不要提交：个人覆盖值放 `.env.local` / `.env.{NODE_ENV}.local`（已 gitignore），生产环境由部署平台直接注入（`process.env` 优先级最高）。
- **`.env.*` 一律不入库**：`.env.example` 是唯一的提交模板，新成员复制为 `.env` 后按需修改；`.env.development` / `.env.test` 等环境文件同样被 gitignore，其默认值由 `.env.example` 与 Joi schema 的 default 提供。

## 项目约定

- **路径别名**：`@/` 指向 `src/`，例如 `import { AppModule } from '@/app.module'`。
- **导入排序**：由 ESLint（`eslint-plugin-simple-import-sort`）自动整理，运行 `pnpm lint` 修复。
- **测试目录**：所有测试文件统一放在 `test/` 目录下，目录结构与 `src/` 对应。
- **业务异常约定**：`BusinessException` 固定返回 HTTP 200 + 响应体业务 `code`（国内业务码惯例）。代价是 APM/告警无法按状态码识别失败，且错误响应可能被中间层缓存——接入 CDN 时务必复查。
- **应用装配**：全局管道/前缀/CORS/helmet/Swagger 统一在 `src/app.setup.ts` 的 `configureApp` 中挂载，`main.ts` 与 e2e 共用；全局过滤器/守卫/拦截器在 `app.module.ts` 的 providers 中注册。

## 部署

将 NestJS 应用部署到生产环境前，可以参考[官方部署文档](https://docs.nestjs.com/deployment)了解关键步骤与优化建议。

> 注意：构建产物 `dist/main.js` 在运行时会读取项目根目录的 `package.json`（Swagger 版本号），打包制品时请保证 `dist/` 与根 `package.json` 一同发布。

如果需要云端部署平台，可以使用官方的 [Mau](https://mau.nestjs.com)，在 AWS 上部署只需几步：

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

## 相关资源

以下资源在使用 NestJS 时可能会有帮助：

- 访问 [NestJS 官方文档](https://docs.nestjs.com) 深入了解框架。
- 如有问题或需要支持，欢迎加入 [Discord 频道](https://discord.gg/G7Qnnhy)。
- 想要更多实战经验，可以查看官方[视频课程](https://courses.nestjs.com/)。
- 使用 [NestJS Devtools](https://devtools.nestjs.com) 可视化应用结构并实时交互。
- 需要项目支持（兼职到全职），可了解官方[企业支持服务](https://enterprise.nestjs.com)。
- 关注 [X](https://x.com/nestframework) 与 [LinkedIn](https://linkedin.com/company/nestjs) 获取最新动态。

## 许可证

Nest 采用 [MIT 许可证](https://github.com/nestjs/nest/blob/master/LICENSE)开源。
