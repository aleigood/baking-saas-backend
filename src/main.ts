import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    // Global Filters
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new AllExceptionsFilter(httpAdapterHost));

    // Swagger Document Setup
    const config = new DocumentBuilder()
        .setTitle('Baking SaaS API')
        .setDescription('The Baking SaaS API documentation')
        .setVersion('1.0')
        .addBearerAuth()
        .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api-docs', app, document);

    // Global Pipes
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
        }),
    );

    // Enable CORS
    app.enableCors();

    await app.listen(9527);
}
// --- 修复点 2: 解决“悬空Promise”警告 ---
// 使用 void 明确告诉ESLint，我们知道这是一个Promise，
// 但我们不需要等待它完成，这是应用启动时的标准做法。
void bootstrap();
