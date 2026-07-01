import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { UserPayload } from './interfaces/user-payload.interface';
import { TenantStatus, UserStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(
        private prisma: PrismaService,
        configService: ConfigService,
    ) {
        const jwtSecret = configService.get<string>('JWT_SECRET');
        if (!jwtSecret) throw new Error('JWT_SECRET is not defined in the environment variables');
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            secretOrKey: jwtSecret,
        });
    }

    async validate(payload: JwtPayload & { iat: number; exp: number }): Promise<UserPayload> {
        if (!payload.tenantRole || !payload.globalRole) {
            throw new UnauthorizedException('登录凭证版本已更新，请重新登录');
        }

        const user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
            select: { globalRole: true, status: true },
        });

        if (!user || user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException('用户不存在或令牌无效');
        }

        let tenantRole = payload.tenantRole;
        if (payload.tenantId) {
            const membership = await this.prisma.tenantUser.findUnique({
                where: { userId_tenantId: { userId: payload.sub, tenantId: payload.tenantId } },
                select: { role: true, status: true, tenant: { select: { status: true } } },
            });

            if (!membership || membership.status !== UserStatus.ACTIVE) {
                throw new UnauthorizedException('您已不属于当前店铺，请重新登录');
            }
            if (membership.tenant.status === TenantStatus.INACTIVE) {
                throw new UnauthorizedException('该店铺已被停用，无法进行操作');
            }
            tenantRole = membership.role;
        }

        // 返回的用户信息将附加到 Express 的 request.user 对象上
        return {
            sub: payload.sub,
            tenantId: payload.tenantId,
            tenantRole,
            globalRole: user.globalRole,
            iat: payload.iat,
            exp: payload.exp,
        };
    }
}
