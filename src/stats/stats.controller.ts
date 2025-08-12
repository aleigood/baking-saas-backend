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
     * [新增] 获取生产主页的核心统计数据接口
     */
    @Get('production-home')
    getProductionHomeStats(@GetUser() user: UserPayload) {
        return this.statsService.getProductionHomeStats(user.tenantId);
    }

    @Get('production')
    getProductionStats(@GetUser() user: UserPayload, @Query() statsDto: StatsDto) {
        // 修复：调用新的统计方法
        return this.statsService.getProductionStats(user.tenantId, statsDto);
    }
}
