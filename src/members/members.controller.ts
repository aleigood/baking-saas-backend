/**
 * 文件路径: src/members/members.controller.ts
 * 文件描述: (已更新) 增加了角色更新和员工删除的API端点。
 */
import {
  Controller,
  Get,
  UseGuards,
  Patch,
  Param,
  Body,
  Delete,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { MembersService } from './members.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { MemberDto } from './dto/member.dto';
import { UpdateMemberRoleDto } from './dto/update-member.dto';

@UseGuards(AuthGuard('jwt'))
@Controller('members')
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  findAll(@GetUser() user: UserPayload): Promise<MemberDto[]> {
    return this.membersService.findAllForTenant(user.tenantId);
  }

  /**
   * [新增] 更新成员角色的端点
   * @route PATCH /members/:id/role
   * @param id - 目标成员的用户ID
   * @param updateMemberRoleDto - 包含新角色的请求体
   * @param user - 发起操作的当前用户
   */
  @Patch(':id/role')
  updateRole(
    @Param('id') id: string,
    @Body() updateMemberRoleDto: UpdateMemberRoleDto,
    @GetUser() user: UserPayload,
  ) {
    return this.membersService.updateRole(id, updateMemberRoleDto.role, user);
  }

  /**
   * [新增] "软删除"一个成员的端点
   * @route DELETE /members/:id
   * @param id - 目标成员的用户ID
   * @param user - 发起操作的当前用户
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @GetUser() user: UserPayload) {
    return this.membersService.remove(id, user);
  }
}
