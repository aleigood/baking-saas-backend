import { Controller, Get, UseGuards, Post, Body } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { TenantDataDto } from './dto/tenant-data.dto';

@UseGuards(AuthGuard('jwt'))
@Controller('tenants')
export class TenantsController {
    constructor(private readonly tenantsService: TenantsService) {}

    @Get()
    findAllForUser(@GetUser() user: UserPayload) {
        // 修复：用户ID在 'sub' 字段中
        return this.tenantsService.findAllForUser(user.sub);
    }

    @Post()
    create(@GetUser() user: UserPayload, @Body() tenantData: TenantDataDto) {
        return this.tenantsService.create(user.sub, tenantData);
    }
}
