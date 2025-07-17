/**
 * 文件路径: src/auth/jwt.strategy.ts
 * 文件描述:
 * 这个类负责从HTTP请求中提取JWT令牌，并验证其有效性。
 * 它会自动处理令牌的解密和过期检查。
 */
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { UserPayload } from './interfaces/user-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  /**
   * 构造函数，配置JWT策略。
   */
  constructor() {
    super({
      // 从请求的Authorization头中提取Bearer Token
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // 确保令牌未过期
      ignoreExpiration: false,
      // 使用与签发令牌时相同的密钥来验证签名
      secretOrKey: 'YOUR_SECRET_KEY', // 必须与auth.module.ts中的密钥一致
    });
  }

  /**
   * 验证通过后，此方法被调用。
   * @param payload - 从JWT令牌中解码出的载荷
   * @returns 返回一个包含用户身份信息的对象，该对象将被附加到请求的 user 属性上。
   */
  validate(payload: JwtPayload): UserPayload {
    // 将JWT载荷转换为我们在应用中方便使用的UserPayload格式
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
    };
  }
}
