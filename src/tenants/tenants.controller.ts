import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@UseGuards(AuthGuard('jwt'))
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  findAll(@GetUser() user: UserPayload) {
    return this.tenantsService.findAllForUser(user.userId);
  }
}
