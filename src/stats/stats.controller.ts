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

    // [核心修改] 移除了已废弃的 /dashboard/production 接口
    // [核心修改] 移除了已废弃的 /production-home 接口

    @Get('production')
    getProductionStats(@GetUser() user: UserPayload, @Query() statsDto: StatsDto) {
        return this.statsService.getProductionStats(user.tenantId, statsDto);
    }
}
