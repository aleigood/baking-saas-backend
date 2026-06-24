import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { EntitlementsService } from './entitlements.service';
import { ENTITLEMENT_FEATURE_KEY, EntitlementFeature } from './requires-feature.decorator';

@Injectable()
export class FeatureGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly entitlements: EntitlementsService,
    ) {}

    async canActivate(context: ExecutionContext) {
        const feature = this.reflector.getAllAndOverride<EntitlementFeature>(ENTITLEMENT_FEATURE_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (!feature) return true;
        const user = context.switchToHttp().getRequest<{ user: UserPayload }>().user;
        await this.entitlements.assertFeature(user.tenantId, feature);
        return true;
    }
}
