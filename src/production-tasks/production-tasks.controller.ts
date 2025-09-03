import {
    Controller,
    Get,
    Post,
    Body,
    Patch,
    Param,
    Delete,
    UseGuards,
    ParseUUIDPipe,
    Query,
    ValidationPipe,
} from '@nestjs/common';
import { ProductionTasksService } from './production-tasks.service';
import { CreateProductionTaskDto } from './dto/create-production-task.dto';
import { UpdateProductionTaskDto } from './dto/update-production-task.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { CompleteProductionTaskDto } from './dto/complete-production-task.dto';
import { QueryProductionTaskDto } from './dto/query-production-task.dto';
import { QueryTaskDetailDto } from './dto/query-task-detail.dto';

@UseGuards(AuthGuard('jwt'))
@Controller('production-tasks')
export class ProductionTasksController {
    constructor(private readonly productionTasksService: ProductionTasksService) {}

    @Post()
    create(@GetUser() user: UserPayload, @Body() createProductionTaskDto: CreateProductionTaskDto) {
        return this.productionTasksService.create(user.tenantId, createProductionTaskDto);
    }

    /**
     * [核心改造] 新增：专门用于获取生产主页的活动任务（进行中、待开始）
     * [修改] 增加 date 查询参数，用于按日期筛选
     */
    @Get('active')
    findActive(@GetUser() user: UserPayload, @Query('date') date?: string) {
        return this.productionTasksService.findActive(user.tenantId, date);
    }

    /**
     * [新增] 获取所有存在任务的日期
     */
    @Get('task-dates')
    getTaskDates(@GetUser() user: UserPayload) {
        return this.productionTasksService.getTaskDates(user.tenantId);
    }

    /**
     * [核心新增] 获取预设的损耗阶段列表
     */
    @Get('spoilage-stages')
    getSpoilageStages() {
        return this.productionTasksService.getSpoilageStages();
    }

    /**
     * [核心改造] 新增：专门用于获取历史任务（已完成、已取消），支持分页
     */
    @Get('history')
    findHistory(
        @GetUser() user: UserPayload,
        @Query(new ValidationPipe({ transform: true }))
        queryDto: QueryProductionTaskDto,
    ) {
        return this.productionTasksService.findHistory(user.tenantId, queryDto);
    }

    @Get(':id')
    findOne(
        @GetUser() user: UserPayload,
        @Param('id') id: string,
        @Query(new ValidationPipe({ transform: true }))
        query: QueryTaskDetailDto,
    ) {
        return this.productionTasksService.findOne(user.tenantId, id, query);
    }

    @Patch(':id')
    update(
        @GetUser() user: UserPayload,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() updateProductionTaskDto: UpdateProductionTaskDto,
    ) {
        return this.productionTasksService.update(user.tenantId, id, updateProductionTaskDto);
    }

    @Delete(':id')
    remove(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string) {
        return this.productionTasksService.remove(user.tenantId, id);
    }

    @Post(':id/complete')
    complete(
        @GetUser() user: UserPayload, // [核心修改] 注入当前用户信息
        @Param('id', ParseUUIDPipe) id: string,
        @Body() completeProductionTaskDto: CompleteProductionTaskDto,
    ) {
        // [核心修改] 将 tenantId 和 userId 传递给 service 层
        return this.productionTasksService.complete(user.tenantId, user.sub, id, completeProductionTaskDto);
    }
}
