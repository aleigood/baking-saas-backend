import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
    private readonly logger = new Logger(AllExceptionsFilter.name);

    constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

    catch(exception: unknown, host: ArgumentsHost): void {
        const { httpAdapter } = this.httpAdapterHost;

        const ctx = host.switchToHttp();

        const httpStatus =
            exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

        // [核心修改] 优化错误信息的提取逻辑，以符合 TypeScript-ESLint 的类型安全规则
        const exceptionResponse =
            exception instanceof HttpException ? exception.getResponse() : 'Internal server error';

        let message: string | object;
        // 检查 exceptionResponse 是否是一个对象，并且不是 null，同时包含 'message' 属性
        if (typeof exceptionResponse === 'object' && exceptionResponse !== null && 'message' in exceptionResponse) {
            // 在此代码块内，TypeScript 知道 exceptionResponse 是一个至少包含 'message' 键的对象
            // 使用类型断言来帮助 TypeScript 理解 message 的具体类型，避免 `unknown` 带来的问题
            message = (exceptionResponse as { message: string | object }).message;
        } else {
            // 如果不符合上述条件，直接使用原始的响应（通常是字符串）
            message = exceptionResponse;
        }

        const responseBody = {
            statusCode: httpStatus,
            timestamp: new Date().toISOString(),
            path: httpAdapter.getRequestUrl(ctx.getRequest()) as string,
            method: httpAdapter.getRequestMethod(ctx.getRequest()) as string,
            message: message, // 使用经过类型安全处理后的 message
        };
        const request = ctx.getRequest<{ ip?: string; headers?: Record<string, string | undefined> }>();
        const logMessage = `HTTP Status: ${httpStatus} Path: ${responseBody.path} IP: ${request.ip || '-'} Error Message: ${JSON.stringify(responseBody.message)}`;
        if (httpStatus >= 500) {
            this.logger.error(logMessage, exception instanceof Error ? exception.stack : '');
        } else if (httpStatus === HttpStatus.NOT_FOUND) {
            const scannerPath = /^\/(?:\.git|\.env|wp-admin|wp-login)/i.test(responseBody.path);
            if (scannerPath) this.logger.warn(`安全扫描请求 ${logMessage}`);
            else this.logger.debug(logMessage);
        } else {
            this.logger.warn(logMessage);
        }

        httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
    }
}
