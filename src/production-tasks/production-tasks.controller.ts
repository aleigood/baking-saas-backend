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
    Res,
    BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
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

    // [核心修正] 必须放在 :id 之前！防止路由冲突导致 404
    @Get('prep-task-pdf')
    async downloadPrepTaskPdf(@GetUser() user: UserPayload, @Query('date') date: string, @Res() res: Response) {
        if (!date) {
            throw new BadRequestException('日期不能为空');
        }
        const stream = await this.productionTasksService.generatePrepTaskPdf(user.tenantId, date);

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="prep-task-${date}.pdf"`,
        });

        stream.pipe(res);
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

    // [注意] 动态参数路由 :id 必须放在具体的静态路由之后
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

    @Get(':id/pdf')
    async downloadPdf(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
        const stream = await this.productionTasksService.generatePdf(user.tenantId, id);

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="task-${id.substring(0, 8)}.pdf"`,
        });

        stream.pipe(res);
    }
}
