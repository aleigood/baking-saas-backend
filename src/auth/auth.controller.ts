import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto } from './dto/auth.dto';

@Controller('auth') // 所有路由都以 /auth 开头
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register') // 处理 POST /auth/register 请求
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('login') // 处理 POST /auth/login 请求
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }
}
