/**
 * 文件路径: src/tasks/tasks.controller.ts
 * 文件描述: 接收制作任务相关的HTTP请求。
 */
import {
  Controller,
  Post,
  Body,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@UseGuards(AuthGuard('jwt'))
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  /**
   * 创建新制作任务的端点
   * @route POST /tasks
   */
  @Post()
  create(@Body() createTaskDto: CreateTaskDto, @GetUser() user: UserPayload) {
    return this.tasksService.create(createTaskDto, user);
  }

  /**
   * 更新任务状态的端点 (例如：完成或取消)
   * @route PATCH /tasks/:id/status
   */
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() updateTaskStatusDto: UpdateTaskStatusDto,
    @GetUser() user: UserPayload,
  ) {
    return this.tasksService.updateStatus(id, updateTaskStatusDto, user);
  }
}
