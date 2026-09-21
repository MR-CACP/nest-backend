# 多阶段构建：依赖安装与编译分离，运行层只含 dist 产物 + 生产依赖 + 非 root 用户
# 构建上下文必须是仓库根目录（compose 中 context: ..）
# 注：不写 # syntax= 外部构建器声明——本文件只用基础指令，可离线走本地 BuildKit 前端
# 基础镜像钉到具体版本（node:24 的滚动标签不可复现），升级时同步改这里

FROM node:24.21.0-alpine AS deps
WORKDIR /app
# 只拷贝清单文件：源码变更不触发依赖层重建
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --ignore-scripts：本项目依赖无需 postinstall 构建（供应链策略与 pnpm-workspace.yaml 白名单一致，
# 容器内也没有编译原生模块的工具链）
RUN corepack enable \
 && corepack prepare --activate \
 && pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN pnpm build

# 生产依赖单独安装，不带 devDependencies（nest/tsc/eslint 等不进运行镜像）
FROM node:24.21.0-alpine AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable \
 && corepack prepare --activate \
 && pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:24.21.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# 非 root 运行：镜像内不保留源码与依赖构建期文件
RUN addgroup -S app && adduser -S app -G app
COPY --chown=app:app package.json ./
COPY --chown=app:app --from=prod-deps /app/node_modules ./node_modules
COPY --chown=app:app --from=build /app/dist ./dist

USER app
EXPOSE 3000

# shell 形式：运行期展开 PORT/API_PREFIX，与 compose 注入的环境一致
# ${PORT:-3000} 中 $$ 前的 \$ 由 compose 层再转义一次，docker 直接收到 shell 文本
# 探针用 /health/live（进程存活）：依赖故障不应触发容器重启，
# 依赖可用性由 /health/ready 交给编排器/负载均衡判断
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/${API_PREFIX:-api}/health/live" || exit 1

CMD ["node", "dist/main"]
