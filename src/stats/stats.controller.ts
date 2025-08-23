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

    /**
     * [核心改造] 新增：为生产主页提供一站式聚合数据的接口
     */
    @Get('/dashboard/production')
    getProductionDashboard(@GetUser() user: UserPayload) {
        return this.statsService.getProductionDashboard(user.tenantId);
    }

    /**
     * [旧接口保留] 获取生产主页的核心统计数据接口
     */
    @Get('production-home')
    getProductionHomeStats(@GetUser() user: UserPayload) {
        return this.statsService.getProductionHomeStats(user.tenantId);
    }

    @Get('production')
    getProductionStats(@GetUser() user: UserPayload, @Query() statsDto: StatsDto) {
        return this.statsService.getProductionStats(user.tenantId, statsDto);
    }
}
