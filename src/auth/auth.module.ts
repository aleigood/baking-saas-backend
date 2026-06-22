/**
 * 文件路径: src/auth/auth.module.ts
 * 文件描述: (已重构) 使用 ConfigService 动态注册 JwtModule。
 */
import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
// import { InvitationsModule } from '../invitations/invitations.module'; // [核心删除] 移除导入
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
    imports: [
        PassportModule,
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            // [核心修复] 移除非必要的 async 关键字，解决 @typescript-eslint/require-await 警告
            useFactory: (configService: ConfigService) => {
                const secret = configService.get<string>('JWT_SECRET');
                if (!secret) {
                    throw new Error('JWT_SECRET is not defined in the environment variables');
                }
                return {
                    secret: secret,
                    // [核心修改] 将 Token 有效期从 1天 ('1d') 延长至 30天 ('30d')，避免用户频繁掉线
                    // 如果需要更长时间，可以设置为 '365d' (1年)
                    signOptions: { expiresIn: '30d' },
                };
            },
        }),
        // InvitationsModule, // [核心删除] 移除导入
    ],
    controllers: [AuthController],
    providers: [AuthService, JwtStrategy],
    exports: [AuthService],
})
export class AuthModule {}
