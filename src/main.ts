import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);

    // 新增：配置静态文件服务
    app.useStaticAssets(join(__dirname, '..', 'public'));

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
    // [核心修复] 修改 CORS 配置以暴露 Content-Disposition
    app.enableCors({
        origin: true, // 允许所有来源跨域，或者你可以指定具体的域名
        credentials: true,
        exposedHeaders: ['Content-Disposition'], // 关键：允许前端读取这个响应头
    });

    await app.listen(9527);
}
void bootstrap();
