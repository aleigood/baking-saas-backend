/**
 * 文件描述:
 * 这个文件是认证模块的控制器（Controller）。
 * 它负责接收来自客户端的HTTP请求（如POST /auth/register），
 * 并调用相应的服务（AuthService）来处理业务逻辑。
 */
import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Get,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto, LoginDto, WechatLoginDto } from './dto/auth.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from './decorators/get-user.decorator';
import { UserPayload } from './interfaces/user-payload.interface';

@Controller('auth') // 定义了所有API路由都以 /auth 为前缀
export class AuthController {
  /**
   * 构造函数，通过依赖注入的方式，引入了AuthService的实例。
   */
  constructor(private readonly authService: AuthService) {}

  /**
   * 处理老板注册请求
   * @decorator @Post('register') - 监听 POST /auth/register 路由
   * @decorator @Body() - 获取请求体中的数据并自动转换为RegisterDto对象
   */
  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  /**
   * 处理邮箱密码登录请求
   */
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  /**
   * 处理所有微信相关的登录请求
   */
  @HttpCode(HttpStatus.OK)
  @Post('wechat-login')
  async wechatLogin(@Body() wechatLoginDto: WechatLoginDto) {
    return this.authService.loginByWechat(wechatLoginDto);
  }

  /**
   * 获取当前登录用户信息的端点
   * @route GET /auth/me
   */
  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  getProfile(@GetUser() user: UserPayload) {
    // GetUser 装饰器从 token 中解析出 payload
    // 然后我们调用 service 来根据 userId 获取完整的、安全的用户信息
    return this.authService.getProfile(user.userId);
  }
}
