import { Controller, Get, UseGuards } from '@nestjs/common';
import { StatsService } from './stats.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@UseGuards(AuthGuard('jwt'))
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('recipes')
  findRecipeStats(@GetUser() user: UserPayload) {
    return this.statsService.findRecipeStats(user.tenantId);
  }

  @Get('ingredients')
  findIngredientStats(@GetUser() user: UserPayload) {
    return this.statsService.findIngredientStats(user.tenantId);
  }
}
