import {
    Controller,
    Get,
    Patch,
    Param,
    Body,
    Delete,
    UseGuards,
    ParseUUIDPipe,
    Query,
    Post,
    ForbiddenException,
} from '@nestjs/common';
import { MembersService } from './members.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { UpdateMemberDto } from './dto/update-member.dto'; // 修复：使用正确的DTO名称
import { CreateMemberDto } from './dto/create-member.dto'; // [核心新增] 导入CreateMemberDto
import { Role } from '@prisma/client';

@UseGuards(AuthGuard('jwt'))
@Controller('members')
export class MembersController {
    constructor(private readonly membersService: MembersService) {}

    @Post()
    create(@GetUser() user: UserPayload, @Body() createMemberDto: CreateMemberDto) {
        // [核心新增] 创建新成员的端点
        return this.membersService.create(user.tenantId, createMemberDto, user);
    }

    /**
     * [核心新增] 获取所有者名下所有店铺的全部成员列表
     */
    @Get('all-by-owner')
    findAllInAllTenantsByOwner(@GetUser() user: UserPayload) {
        if (user.role !== Role.OWNER) {
            throw new ForbiddenException('只有店铺所有者才能访问此资源。');
        }
        return this.membersService.findAllInAllTenantsByOwner(user.sub);
    }

    @Get()
    findAll(@GetUser() user: UserPayload, @Query('tenantId') tenantId?: string) {
        // [核心修改] 允许所有者跨店铺查询，否则使用token中的tenantId
        const targetTenantId = this.membersService.getTargetTenantIdForOwner(user, tenantId);
        return this.membersService.findAll(targetTenantId);
    }

    @Get(':id')
    findOne(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string) {
        // [核心修改] 此处也应使用目标店铺ID，尽管当前场景不常用
        const targetTenantId = this.membersService.getTargetTenantIdForOwner(user, user.tenantId);
        return this.membersService.findOne(targetTenantId, id);
    }

    @Patch(':id')
    update(
        @GetUser() user: UserPayload,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() updateMemberDto: UpdateMemberDto,
    ) {
        return this.membersService.update(user.tenantId, id, updateMemberDto, user);
    }

    @Delete(':id')
    remove(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string) {
        return this.membersService.remove(user.tenantId, id, user);
    }
}
