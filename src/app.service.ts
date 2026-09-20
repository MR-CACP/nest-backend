import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  // 诊断信息（环境、端口）只进启动日志，不通过公开接口的响应体暴露
  getHello(): string {
    return 'Hello World!';
  }
}
