/**
 * 文件路径: src/auth/jwt.strategy.ts
 * 文件描述: (已重构) 从 ConfigService 获取 JWT 密钥。
 */
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { UserPayload } from './interfaces/user-payload.interface';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  /**
   * 构造函数，配置JWT策略。
   */
  constructor(configService: ConfigService) {
    const secretOrKey = configService.get<string>('JWT_SECRET');

    // [核心修复] 增加安全校验，确保环境变量存在，这会解决TypeScript的类型错误
    if (!secretOrKey) {
      throw new Error(
        'JWT_SECRET is not defined in the environment variables. Make sure it is set in your .env file.',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secretOrKey,
    });
  }

  /**
   * 验证通过后，此方法被调用。
   * @param payload - 从JWT令牌中解码出的载荷
   * @returns 返回一个包含用户身份信息的对象，该对象将被附加到请求的 user 属性上。
   */
  validate(payload: JwtPayload): UserPayload {
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
    };
  }
}
