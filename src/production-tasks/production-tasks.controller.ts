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

@UseGuards(AuthGuard('jwt'))
@Controller('production-tasks')
export class ProductionTasksController {
    constructor(private readonly productionTasksService: ProductionTasksService) {}

    @Post()
    create(@GetUser() user: UserPayload, @Body() createProductionTaskDto: CreateProductionTaskDto) {
        return this.productionTasksService.create(user.tenantId, createProductionTaskDto);
    }

    @Get()
    findAll(
        @GetUser() user: UserPayload,
        @Query(new ValidationPipe({ transform: true }))
        queryDto: QueryProductionTaskDto,
    ) {
        // 此处无需修改，它会直接返回 service 中新的 { tasks, prepTask } 结构
        // (No changes needed here, it will directly return the new { tasks, prepTask } structure from the service)
        return this.productionTasksService.findAll(user.tenantId, queryDto);
    }

    @Get(':id')
    findOne(@GetUser() user: UserPayload, @Param('id') id: string) {
        // [修改] id 不再强制为 UUID，因为前置任务的 ID 是一个固定字符串
        return this.productionTasksService.findOne(user.tenantId, id);
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
