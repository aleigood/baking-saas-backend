import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { UserPayload } from './interfaces/user-payload.interface';
import { Role, TenantStatus } from '@prisma/client'; // [核心新增] 导入 TenantStatus

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(private prisma: PrismaService) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            secretOrKey: process.env.JWT_SECRET || 'your-secret-key',
        });
    }

    async validate(payload: JwtPayload & { iat: number; exp: number }): Promise<UserPayload> {
        const user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
        });

        if (!user) {
            throw new UnauthorizedException('用户不存在或令牌无效');
        }

        // [核心新增] 增加对店铺状态的校验
        // 超级管理员不受店铺状态限制
        if (payload.globalRole !== Role.SUPER_ADMIN && payload.tenantId) {
            const tenant = await this.prisma.tenant.findUnique({
                where: { id: payload.tenantId },
                select: { status: true },
            });

            // 如果店铺不存在或已被停用，则拒绝访问
            if (!tenant || tenant.status === TenantStatus.INACTIVE) {
                throw new UnauthorizedException('该店铺已被停用，无法进行操作。');
            }
        }

        // 返回的用户信息将附加到 Express 的 request.user 对象上
        return {
            sub: payload.sub,
            tenantId: payload.tenantId,
            role: payload.role,
            globalRole: payload.globalRole,
            iat: payload.iat,
            exp: payload.exp,
        };
    }
}
