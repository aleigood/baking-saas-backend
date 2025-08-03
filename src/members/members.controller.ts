import { Controller, Get, Patch, Param, Body, Delete, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { MembersService } from './members.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { UpdateMemberDto } from './dto/update-member.dto'; // 修复：使用正确的DTO名称

@UseGuards(AuthGuard('jwt'))
@Controller('members')
export class MembersController {
    constructor(private readonly membersService: MembersService) {}

    @Get()
    findAll(@GetUser() user: UserPayload) {
        return this.membersService.findAll(user.tenantId);
    }

    @Get(':id')
    findOne(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string) {
        return this.membersService.findOne(user.tenantId, id);
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
