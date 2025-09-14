import { Controller, Get, UseGuards, Post, Body, Patch, Param } from '@nestjs/common';
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

    /**
     * [核心新增] 更新店铺信息的端点
     * @param id 店铺ID
     * @param user 当前用户信息
     * @param tenantData 更新的数据
     */
    @Patch(':id')
    update(@Param('id') id: string, @GetUser() user: UserPayload, @Body() tenantData: Partial<TenantDataDto>) {
        return this.tenantsService.update(id, user.sub, tenantData);
    }
}
