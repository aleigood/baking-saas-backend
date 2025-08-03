import { Controller, Get, UseGuards, Query } from '@nestjs/common';
import { StatsService } from './stats.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { StatsDto } from './dto/stats.dto';

@UseGuards(AuthGuard('jwt'))
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Get('production')
  getProductionStats(
    @GetUser() user: UserPayload,
    @Query() statsDto: StatsDto,
  ) {
    // 修复：调用新的统计方法
    return this.statsService.getProductionStats(user.tenantId, statsDto);
  }
}
