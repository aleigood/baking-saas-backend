import { Controller, Post, Body, UseGuards, Get, Param, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { AuthDto, BindWechatDto, RegisterDto, SendRegistrationCodeDto, WechatLoginDto } from './dto/auth.dto';
import { GetUser } from './decorators/get-user.decorator';
import { UserPayload } from './interfaces/user-payload.interface';
import { AuthGuard } from '@nestjs/passport';

@Controller('auth')
export class AuthController {
    constructor(private authService: AuthService) {}

    @Post('sms-codes')
    sendRegistrationCode(@Body() dto: SendRegistrationCodeDto, @Req() request: Request) {
        return this.authService.sendRegistrationCode(dto.phone, request.ip);
    }

    @Post('register')
    register(@Body() registerDto: RegisterDto) {
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
    @Post('wechat-bind')
    bindWechat(@GetUser() user: UserPayload, @Body() dto: BindWechatDto) {
        return this.authService.bindWechat(user.sub, dto.code);
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
