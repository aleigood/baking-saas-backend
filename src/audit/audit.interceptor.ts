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

        const record = (statusCode: number, responseBody?: unknown) => {
            const targetId = request.params?.id || request.params?.tenantId || request.params?.orderId || null;
            const event = this.describe(request.method, request.path);
            void this.prisma.auditLog
                .create({
                    data: {
                        actorUserId: user.sub,
                        actorRole: user.globalRole,
                        action: event.action,
                        method: request.method,
                        path: request.originalUrl || request.url,
                        targetType: event.targetType,
                        targetId,
                        statusCode,
                        ipAddress: request.ip,
                        userAgent: request.headers['user-agent'],
                        metadata: {
                            eventType: event.eventType,
                            category: event.category,
                            ...this.responseMetadata(event.eventType, responseBody),
                        },
                    },
                })
                .catch(() => undefined);
        };

        return next.handle().pipe(
            tap((responseBody) => record(context.switchToHttp().getResponse<Response>().statusCode, responseBody)),
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

    private responseMetadata(eventType: string, responseBody: unknown): Record<string, number> {
        if (eventType !== 'RECIPES_BATCH_IMPORTED' || typeof responseBody !== 'object' || responseBody === null)
            return {};
        const body = responseBody as Record<string, unknown>;
        const keys = [
            'totalCount',
            'importedCount',
            'enabledMainRecipeCount',
            'restrictedMainRecipeCount',
            'componentRecipeCount',
            'skippedCount',
        ];
        return Object.fromEntries(keys.flatMap((key) => (typeof body[key] === 'number' ? [[key, body[key]]] : [])));
    }

    private describe(method: string, path: string) {
        const rules: Array<{
            pattern: RegExp;
            action: string;
            eventType: string;
            category: string;
            targetType: string | null;
        }> = [
            {
                pattern: /store-applications\/[^/]+\/approve$/,
                action: '批准开店申请',
                eventType: 'STORE_APPLICATION_APPROVED',
                category: 'STORE',
                targetType: 'store-application',
            },
            {
                pattern: /store-applications\/[^/]+\/reject$/,
                action: '拒绝开店申请',
                eventType: 'STORE_APPLICATION_REJECTED',
                category: 'STORE',
                targetType: 'store-application',
            },
            {
                pattern: /tenants\/[^/]+\/recipes\/batch-import$/,
                action: '初始化店铺配方',
                eventType: 'RECIPES_BATCH_IMPORTED',
                category: 'RECIPE',
                targetType: 'tenant',
            },
            {
                pattern: /recipe-editor\/admin\/tenants\/[^/]+\/sessions$/,
                action: '开启配方编辑会话',
                eventType: 'RECIPE_EDITOR_SESSION_CREATED',
                category: 'RECIPE',
                targetType: 'tenant',
            },
            {
                pattern: /sms-assistance\/code$/,
                action: '查询短信验证码',
                eventType: 'SMS_CODE_VIEWED',
                category: 'SECURITY',
                targetType: 'sms-assistance',
            },
            {
                pattern: /payment-orders\/[^/]+\/refunds$/,
                action: '发起订单退款',
                eventType: 'PAYMENT_ORDER_REFUNDED',
                category: 'BILLING',
                targetType: 'payment-order',
            },
            {
                pattern: /payment-orders\/[^/]+\/sync$/,
                action: '同步支付订单',
                eventType: 'PAYMENT_ORDER_SYNCED',
                category: 'BILLING',
                targetType: 'payment-order',
            },
            {
                pattern: /payment-orders\/reconcile$/,
                action: '批量核对支付订单',
                eventType: 'PAYMENT_ORDERS_RECONCILED',
                category: 'BILLING',
                targetType: 'payment-order',
            },
            {
                pattern: /subscriptions/,
                action: '变更店铺订阅',
                eventType: 'SUBSCRIPTION_CHANGED',
                category: 'BILLING',
                targetType: 'subscription',
            },
            {
                pattern: /users\/[^/]+\/status$/,
                action: '变更账号状态',
                eventType: 'USER_STATUS_CHANGED',
                category: 'ACCOUNT',
                targetType: 'user',
            },
            {
                pattern: /users/,
                action: '变更账号信息',
                eventType: 'USER_CHANGED',
                category: 'ACCOUNT',
                targetType: 'user',
            },
            {
                pattern: /tenants/,
                action: '变更店铺信息',
                eventType: 'TENANT_CHANGED',
                category: 'STORE',
                targetType: 'tenant',
            },
        ];
        const matched = rules.find((rule) => rule.pattern.test(path));
        return (
            matched || {
                action: '执行管理操作',
                eventType: 'ADMIN_REQUEST',
                category: 'OTHER',
                targetType: null,
            }
        );
    }
}
