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
    Put,
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
import { UpdateTaskDetailsDto } from './dto/update-task-details.dto';

@UseGuards(AuthGuard('jwt'))
@Controller('production-tasks')
export class ProductionTasksController {
    constructor(private readonly productionTasksService: ProductionTasksService) {}

    @Post()
    create(@GetUser() user: UserPayload, @Body() createProductionTaskDto: CreateProductionTaskDto) {
        return this.productionTasksService.create(user.tenantId, user.sub, createProductionTaskDto);
    }

    @Get('active')
    findActive(@GetUser() user: UserPayload, @Query('date') date?: string) {
        return this.productionTasksService.findActive(user.tenantId, date);
    }

    // [新增] 为前置任务详情页创建专属接口
    @Get('prep-task-details')
    getPrepTaskDetails(@GetUser() user: UserPayload, @Query('date') date?: string) {
        return this.productionTasksService.getPrepTaskDetails(user.tenantId, date);
    }

    @Get('task-dates')
    getTaskDates(@GetUser() user: UserPayload) {
        return this.productionTasksService.getTaskDates(user.tenantId);
    }

    @Get('spoilage-stages')
    getSpoilageStages() {
        return this.productionTasksService.getSpoilageStages();
    }

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

    @Put(':id')
    updateTaskDetails(
        @GetUser() user: UserPayload,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() updateTaskDetailsDto: UpdateTaskDetailsDto,
    ) {
        return this.productionTasksService.updateTaskDetails(user.tenantId, id, updateTaskDetailsDto);
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
        return this.productionTasksService.complete(user.tenantId, user.sub, id, completeProductionTaskDto);
    }
}
