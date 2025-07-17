import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: 'YOUR_SECRET_KEY', // 强烈建议换成一个更复杂的、从环境变量读取的密钥
      signOptions: { expiresIn: '1d' }, // 令牌有效期为1天
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
