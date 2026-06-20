import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
    constructor(private readonly prisma: PrismaService) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const request = context.switchToHttp().getRequest<any>();
        const user = request.user;
        if (!user || user.globalRole !== Role.SUPER_ADMIN || request.method === 'GET') return next.handle();

        const record = (statusCode: number) => {
            const targetId = request.params?.id || request.params?.tenantId || request.params?.orderId || null;
            void this.prisma.auditLog.create({
                data: {
                    actorUserId: user.sub,
                    actorRole: user.globalRole,
                    action: `${request.method} ${request.route?.path || request.path}`,
                    method: request.method,
                    path: request.originalUrl || request.url,
                    targetType: this.targetType(request.path),
                    targetId,
                    statusCode,
                    ipAddress: request.ip,
                    userAgent: request.headers['user-agent'],
                },
            }).catch(() => undefined);
        };

        return next.handle().pipe(
            tap(() => record(context.switchToHttp().getResponse().statusCode)),
            catchError((error: any) => {
                record(error?.status || 500);
                return throwError(() => error);
            }),
        );
    }

    private targetType(path: string): string | null {
        const match = path.match(/super-admin\/(users|tenants|subscriptions|subscription-plans|payment-orders)/);
        return match?.[1] || null;
    }
}
