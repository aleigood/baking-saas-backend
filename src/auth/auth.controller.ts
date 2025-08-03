import { Controller, Post, Body, UseGuards, Get, Param } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthDto, RegisterDto, WechatLoginDto } from './dto/auth.dto';
import { GetUser } from './decorators/get-user.decorator';
import { UserPayload } from './interfaces/user-payload.interface';
import { AuthGuard } from '@nestjs/passport';

@Controller('auth')
export class AuthController {
    constructor(private authService: AuthService) {}

    @Post('register')
    register(@Body() registerDto: RegisterDto): Promise<{ accessToken: string }> {
        return this.authService.register(registerDto);
    }

    @Post('login')
    login(@Body() loginDto: AuthDto): Promise<{ accessToken: string }> {
        return this.authService.login(loginDto);
    }

    @Post('wechat-login')
    loginByWechat(@Body() wechatLoginDto: WechatLoginDto) {
        return this.authService.loginByWechat(wechatLoginDto);
    }

    @UseGuards(AuthGuard('jwt'))
    @Post('switch-tenant/:tenantId')
    switchTenant(@GetUser() user: UserPayload, @Param('tenantId') tenantId: string): Promise<{ accessToken: string }> {
        return this.authService.switchTenant(user.sub, tenantId);
    }

    @UseGuards(AuthGuard('jwt'))
    @Get('profile')
    getProfile(@GetUser() user: UserPayload) {
        return this.authService.getProfile(user.sub);
    }
}
