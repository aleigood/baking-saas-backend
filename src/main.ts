import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 启用CORS，允许小程序端跨域访问
  app.enableCors();

  await app.listen(3000);
  console.log(`Application is running on: ${await app.getUrl()}`);
}
// --- 修复点 2: 解决“悬空Promise”警告 ---
// 使用 void 明确告诉ESLint，我们知道这是一个Promise，
// 但我们不需要等待它完成，这是应用启动时的标准做法。
void bootstrap();
