import { Controller, Get, UseGuards } from '@nestjs/common';
import { MembersService } from './members.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@UseGuards(AuthGuard('jwt'))
@Controller('members')
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  findAll(@GetUser() user: UserPayload) {
    return this.membersService.findAllForTenant(user.tenantId);
  }
}
