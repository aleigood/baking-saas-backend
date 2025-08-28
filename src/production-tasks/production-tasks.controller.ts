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
import { QueryTaskDetailDto } from './dto/query-task-detail.dto'; // [新增] 导入新的 DTO

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
     */
    @Get('active')
    findActive(@GetUser() user: UserPayload) {
        return this.productionTasksService.findActive(user.tenantId);
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
    // [修改] findOne 方法现在接收 QueryTaskDetailDto 来处理温度相关的查询参数
    findOne(
        @GetUser() user: UserPayload,
        @Param('id') id: string,
        @Query(new ValidationPipe({ transform: true }))
        query: QueryTaskDetailDto,
    ) {
        return this.productionTasksService.findOne(user.tenantId, id, query); // [修改] 将 query 传递给 service
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
        @GetUser() user: UserPayload,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() completeProductionTaskDto: CompleteProductionTaskDto,
    ) {
        return this.productionTasksService.complete(user.tenantId, id, completeProductionTaskDto);
    }
}
