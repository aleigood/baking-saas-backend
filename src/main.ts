import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common'; // 1. 导入 ValidationPipe

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 2. 启用全局验证管道
  // 这会让所有进入应用的请求都经过 class-validator 的检查
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // 自动剥离 DTO 中未定义的属性
      transform: true, // 自动转换传入的数据类型
    }),
  );

  await app.listen(3000);
}
// --- 修复点 2: 解决“悬空Promise”警告 ---
// 使用 void 明确告诉ESLint，我们知道这是一个Promise，
// 但我们不需要等待它完成，这是应用启动时的标准做法。
void bootstrap();
