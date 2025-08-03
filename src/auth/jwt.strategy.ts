import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { UserPayload } from './interfaces/user-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET || 'your-secret-key',
    });
  }

  async validate(
    payload: JwtPayload & { iat: number; exp: number },
  ): Promise<UserPayload> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user) {
      throw new UnauthorizedException('用户不存在或令牌无效');
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
