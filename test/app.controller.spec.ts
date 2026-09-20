import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { AppController } from '../src/app.controller';
import { AppService } from '../src/app.service';
import { BusinessException } from '../src/common/exceptions/business.exception';
import { appConfig } from '../src/config/configuration';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    // AppController 注入了 app 配置命名空间，单测中用工厂默认值代替
    const appConfigProvider = {
      provide: appConfig.KEY,
      useFactory: () => appConfig(),
    };
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService, appConfigProvider],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('应该返回 Hello World! 问候语', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('演示路由开关（DEMO_ROUTES_ENABLED）', () => {
    const makeController = (demoRoutesEnabled: boolean): AppController =>
      new AppController(new AppService(), {
        ...appConfig(),
        demoRoutesEnabled,
      });

    it('开关关闭时演示路由按 404 处理', () => {
      expect(() => makeController(false).getError()).toThrow(NotFoundException);
    });

    it('开关开启时正常抛出业务异常', () => {
      expect(() => makeController(true).getError()).toThrow(BusinessException);
    });
  });
});
