import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Role, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@Injectable()
export class SubscriptionGuard implements CanActivate {
    constructor(private readonly prisma: PrismaService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (process.env.SUBSCRIPTION_ENFORCEMENT_ENABLED !== 'true') return true;
        const user = context.switchToHttp().getRequest<{ user: UserPayload }>().user;
        if (!user || user.globalRole === Role.SUPER_ADMIN) return true;
        const now = new Date();
        const subscription = await this.prisma.tenantSubscription.findFirst({
            where: { tenantId: user.tenantId, status: SubscriptionStatus.ACTIVE, startsAt: { lte: now }, expiresAt: { gt: now } },
            select: { id: true },
        });
        if (subscription) return true;
        throw new HttpException({ statusCode: 402, code: 'SUBSCRIPTION_REQUIRED', message: '店铺订阅已到期，请续费后继续使用' }, 402);
    }
}
