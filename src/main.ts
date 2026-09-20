import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { configureApp } from './app.setup';

/**
 * 应用引导入口：
 * 1. NODE_ENV fail-fast 校验（必须在动态 import AppModule 之前，原因见下方注释）
 * 2. 创建应用并接管日志（bufferLogs 缓冲启动期日志，避免丢失 pino 接管前的输出）
 * 3. 装配逻辑统一在 app.setup.ts 的 configureApp（与 e2e 共用，保证测试应用等价）
 * 4. 优雅停机钩子 + 监听端口 + 启动日志
 */
async function bootstrap() {
  // NODE_ENV 必须由进程显式注入：静默回退 development 会让生产加载 .env.development
  // （Swagger 开启、演示路由放行、日志降级），宁拒绝启动也不 fail-open。
  // 动态 import：AppModule 的装饰器求值会同步执行 ConfigModule.forRoot 把 .env
  // 注入 process.env，静态 import 会在本检查之前完成这一步
  if (!process.env.NODE_ENV) {
    throw new Error(
      'NODE_ENV 未设置：必须由进程环境注入（cross-env / 部署平台），拒绝以不确定的环境启动',
    );
  }

  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const { appConfig, swaggerConfig } = configureApp(app);

  // 优雅停机：接收 SIGTERM/SIGINT 后等待在途请求处理完再退出
  app.enableShutdownHooks();

  await app.listen(appConfig.port);

  const logger = app.get(Logger);
  logger.log(`环境: ${appConfig.env}`);
  logger.log(
    `接口地址: http://localhost:${appConfig.port}/${appConfig.prefix}`,
  );
  if (swaggerConfig.enabled) {
    logger.log(
      `Swagger 文档: http://localhost:${appConfig.port}/${swaggerConfig.path}`,
    );
  }
}

// 启动失败（Joi 校验不通过、端口占用等）不能只留一条 unhandled rejection：
// 打印错误并以非零码退出，让进程管理器（pm2/docker）能感知并重启
void bootstrap().catch((error: unknown) => {
  console.error('应用启动失败:', error);
  process.exit(1);
});
