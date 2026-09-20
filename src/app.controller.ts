import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Post,
} from '@nestjs/common';

import { EchoDto } from './app.dto';
import { AppService } from './app.service';
import { BusinessException } from './common/exceptions/business.exception';
import { appConfig } from './config/configuration';
import type { AppConfig } from './config/types';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    // 类型安全的配置注入：appConfig.KEY 是 registerAs 生成的类型化令牌
    @Inject(appConfig.KEY) private readonly appConfig: AppConfig,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // 业务异常演示：统一响应格式中的错误路径
  @Get('error')
  getError(): never {
    this.ensureDemoEnabled();
    throw new BusinessException('业务异常示例：库存不足', 40001);
  }

  // 参数校验演示：校验失败会抛出 BadRequestException(400)，由全局过滤器统一格式化
  @Post('echo')
  echo(@Body() dto: EchoDto): EchoDto {
    this.ensureDemoEnabled();
    return dto;
  }

  // 演示/调试路由受显式 feature flag 控制（DEMO_ROUTES_ENABLED），不随生产发布：
  // 开发/测试部署若暴露公网，也不提供异常触发与请求回显入口
  private ensureDemoEnabled(): void {
    if (!this.appConfig.demoRoutesEnabled) {
      throw new NotFoundException();
    }
  }
}
