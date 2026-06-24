import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GlobalRole } from '@prisma/client';
import { Observable, catchError, tap, throwError } from 'rxjs';
import type { Request, Response } from 'express';
import type { UserPayload } from '../auth/interfaces/user-payload.interface';
import { PrismaService } from '../prisma/prisma.service';

type AuditRequest = Request & { user?: UserPayload };

@Injectable()
export class AuditInterceptor implements NestInterceptor {
    constructor(private readonly prisma: PrismaService) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const request = context.switchToHttp().getRequest<AuditRequest>();
        const user = request.user;
        if (!user || user.globalRole !== GlobalRole.SUPER_ADMIN || request.method === 'GET') return next.handle();

        const record = (statusCode: number) => {
            const targetId = request.params?.id || request.params?.tenantId || request.params?.orderId || null;
            void this.prisma.auditLog
                .create({
                    data: {
                        actorUserId: user.sub,
                        actorRole: user.globalRole,
                        action: `${request.method} ${request.path}`,
                        method: request.method,
                        path: request.originalUrl || request.url,
                        targetType: this.targetType(request.path),
                        targetId,
                        statusCode,
                        ipAddress: request.ip,
                        userAgent: request.headers['user-agent'],
                    },
                })
                .catch(() => undefined);
        };

        return next.handle().pipe(
            tap(() => record(context.switchToHttp().getResponse<Response>().statusCode)),
            catchError((error: unknown) => {
                const statusCode =
                    typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
                        ? error.status
                        : 500;
                record(statusCode);
                return throwError(() => error);
            }),
        );
    }

    private targetType(path: string): string | null {
        const match = path.match(
            /super-admin\/(users|tenants|subscriptions|subscription-plans|entitlement-policies|billing-settings|payment-orders)/,
        );
        return match?.[1] || null;
    }
}
