import { Controller, Get, UseGuards } from '@nestjs/common';
import { AppService } from './app.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from './auth/decorators/get-user.decorator';
import { UserPayload } from './auth/interfaces/user-payload.interface';

@Controller()
export class AppController {
    constructor(private readonly appService: AppService) {}

    @Get()
    getHello(): string {
        return this.appService.getHello();
    }

    @UseGuards(AuthGuard('jwt'))
    @Get('profile')
    getProfile(@GetUser() user: UserPayload) {
        // 修复：使用 @GetUser() 装饰器以保持代码风格一致
        return this.appService.getProfile(user);
    }
}
