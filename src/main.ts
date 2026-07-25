import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);
const requestLogger = new Logger('RequestMonitor');

function parseCsvEnv(value?: string) {
    return (value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function isEnabled(value?: string) {
    return TRUTHY_VALUES.has(String(value || '').toLowerCase());
}

function parsePositiveIntEnv(value: string | undefined, fallback: number) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertProductionConfig() {
    if (process.env.NODE_ENV !== 'production') return;

    const missing: string[] = [];
    const invalid: string[] = [];
    const required = ['DATABASE_URL', 'JWT_SECRET', 'PAYMENT_PROVIDER'];

    for (const key of required) {
        if (!process.env[key]) missing.push(key);
    }

    if (!process.env.CORS_ORIGINS && !process.env.ADMIN_ORIGIN && !process.env.MINIAPP_ORIGIN) {
        missing.push('CORS_ORIGINS');
    }

    const smsProvider = String(process.env.SMS_PROVIDER || '').toLowerCase();
    if (!smsProvider) missing.push('SMS_PROVIDER');
    if (smsProvider === 'mock') invalid.push('SMS_PROVIDER');
    if (smsProvider === 'disabled' && !isEnabled(process.env.MANUAL_SMS_VERIFICATION_ENABLED)) {
        invalid.push('SMS_PROVIDER');
    }

    const jwtSecret = process.env.JWT_SECRET || '';
    if (jwtSecret.length < 32 || /replace|changeme|change-me/i.test(jwtSecret)) invalid.push('JWT_SECRET');

    if (missing.length || invalid.length) {
        throw new Error(
            [
                missing.length ? `Missing production env: ${missing.join(', ')}` : '',
                invalid.length ? `Unsafe production env: ${invalid.join(', ')}` : '',
            ]
                .filter(Boolean)
                .join('; '),
        );
    }
}

function buildCorsOrigins() {
    if (process.env.NODE_ENV !== 'production') return true;

    return [
        ...parseCsvEnv(process.env.CORS_ORIGINS),
        ...parseCsvEnv(process.env.ADMIN_ORIGIN),
        ...parseCsvEnv(process.env.MINIAPP_ORIGIN),
    ];
}

function swaggerBasicAuth(req: Request, res: Response, next: NextFunction) {
    const user = process.env.SWAGGER_USER;
    const password = process.env.SWAGGER_PASSWORD;

    if (process.env.NODE_ENV !== 'production' || !user || !password) return next();

    const [, encoded = ''] = String(req.headers.authorization || '').split(' ');
    const [actualUser, actualPassword] = Buffer.from(encoded, 'base64').toString().split(':');

    if (actualUser === user && actualPassword === password) return next();

    res.setHeader('WWW-Authenticate', 'Basic realm="Baking SaaS API Docs"');
    res.status(401).send('Authentication required');
}

function requestMonitor(req: Request, res: Response, next: NextFunction) {
    const startedAt = Date.now();
    const slowThresholdMs = parsePositiveIntEnv(process.env.SLOW_REQUEST_THRESHOLD_MS, 1000);

    res.on('finish', () => {
        const durationMs = Date.now() - startedAt;
        if (durationMs < slowThresholdMs && res.statusCode < 500) return;

        const path = (req.originalUrl || req.url || '').split('?')[0];
        const message = `${req.method} ${path} ${res.statusCode} ${durationMs}ms`;

        if (res.statusCode >= 500) {
            requestLogger.error(message);
        } else {
            requestLogger.warn(message);
        }
    });

    next();
}

async function bootstrap() {
    assertProductionConfig();

    const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
    app.set('trust proxy', 1);
    app.use(requestMonitor);

    // 新增：配置静态文件服务
    app.useStaticAssets(join(__dirname, '..', 'public'));

    // Global Filters
    const httpAdapterHost = app.get(HttpAdapterHost);
    app.useGlobalFilters(new AllExceptionsFilter(httpAdapterHost));

    if (process.env.NODE_ENV !== 'production' || isEnabled(process.env.SWAGGER_ENABLED)) {
        if (process.env.NODE_ENV === 'production' && (!process.env.SWAGGER_USER || !process.env.SWAGGER_PASSWORD)) {
            throw new Error('SWAGGER_USER and SWAGGER_PASSWORD are required when Swagger is enabled in production');
        }

        app.use('/api-docs', swaggerBasicAuth);

        const config = new DocumentBuilder()
            .setTitle('Baking SaaS API')
            .setDescription('The Baking SaaS API documentation')
            .setVersion('1.0')
            .addBearerAuth()
            .build();
        const document = SwaggerModule.createDocument(app, config);
        SwaggerModule.setup('api-docs', app, document);
    }

    // Global Pipes
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
        }),
    );

    app.enableCors({
        origin: buildCorsOrigins(),
        credentials: true,
        exposedHeaders: ['Content-Disposition'],
    });

    await app.listen(9527);
}
void bootstrap();
