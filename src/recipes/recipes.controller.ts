// backend/src/recipes/recipes.controller.ts
import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    Delete,
    UseGuards,
    NotFoundException,
    Patch,
    UseInterceptors,
    UploadedFile,
    ParseFilePipe,
    MaxFileSizeValidator,
    BadRequestException,
    ForbiddenException, // [新增] 导入 ForbiddenException
} from '@nestjs/common';
import { RecipesService } from './recipes.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { FileInterceptor } from '@nestjs/platform-express';
import { BatchImportRecipeDto } from './dto/batch-import-recipe.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BatchImportRequestDto } from './dto/batch-import-request.dto'; // [新增] 导入新的 DTO
import { Role } from '@prisma/client'; // [新增] 导入 Role 枚举

@UseGuards(AuthGuard('jwt'))
@Controller('recipes')
export class RecipesController {
    constructor(private readonly recipesService: RecipesService) {}

    /**
     * [修改] 批量导入配方，增加多店铺支持和权限控制
     */
    @Post('batch-import')
    @UseInterceptors(FileInterceptor('file'))
    async batchImport(
        @UploadedFile(
            new ParseFilePipe({
                validators: [new MaxFileSizeValidator({ maxSize: 1024 * 1024 * 5 })], // 5MB
                fileIsRequired: true,
            }),
        )
        file: Express.Multer.File,
        @GetUser() user: UserPayload,
        @Body() batchImportRequestDto: BatchImportRequestDto, // [修改] 接收 tenantIds
    ) {
        // [新增] 检查用户角色是否为 OWNER
        if (user.role !== Role.OWNER) {
            throw new ForbiddenException('只有店主才能执行此操作。');
        }

        if (file.mimetype !== 'application/json') {
            throw new BadRequestException('文件类型错误，请上传正确的 JSON 文件。');
        }

        let recipesDto: BatchImportRecipeDto[];
        try {
            const fileContent = file.buffer.toString('utf-8');
            const parsedJson: unknown = JSON.parse(fileContent);

            if (!Array.isArray(parsedJson)) {
                throw new BadRequestException('JSON 文件内容必须是一个数组。');
            }

            recipesDto = plainToInstance(BatchImportRecipeDto, parsedJson, {
                enableImplicitConversion: true,
            });

            for (const dto of recipesDto) {
                const validationErrors = await validate(dto);
                if (validationErrors.length > 0) {
                    const errorMessages = validationErrors
                        .map((err) => (err.constraints ? Object.values(err.constraints) : []))
                        .flat();
                    throw new Error(`配方 "${dto.name}" 数据格式不正确: ${errorMessages.join(', ')}`);
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : '无效的JSON文件或文件内容格式错误';
            throw new BadRequestException(message);
        }

        // [修改] 将 userId 和 tenantIds 传递给 service
        return this.recipesService.batchImportRecipes(user.sub, recipesDto, batchImportRequestDto.tenantIds);
    }

    /**
     * [修改] 创建一个全新的配方族。
     */
    @Post()
    create(@GetUser() user: UserPayload, @Body() createRecipeDto: CreateRecipeDto) {
        const tenantId = user.tenantId;
        return this.recipesService.create(tenantId, createRecipeDto);
    }

    /**
     * [新增] 为指定的配方族创建一个新版本。
     */
    @Post(':familyId/versions')
    createVersion(
        @GetUser() user: UserPayload,
        @Param('familyId') familyId: string,
        @Body() createRecipeDto: CreateRecipeDto,
    ) {
        const tenantId = user.tenantId;
        return this.recipesService.createVersion(tenantId, familyId, createRecipeDto);
    }

    /**
     * [核心新增] 修改一个尚未被生产任务使用过的配方版本。
     */
    @Patch(':familyId/versions/:versionId')
    updateVersion(
        @GetUser() user: UserPayload,
        @Param('familyId') familyId: string,
        @Param('versionId') versionId: string,
        @Body() updateRecipeDto: CreateRecipeDto,
    ) {
        const tenantId = user.tenantId;
        return this.recipesService.updateVersion(tenantId, familyId, versionId, updateRecipeDto);
    }

    /**
     * [核心新增] 获取用于创建新版本的表单模板数据
     */
    @Get(':familyId/versions/:versionId/form-template')
    getRecipeVersionFormTemplate(
        @GetUser() user: UserPayload,
        @Param('familyId') familyId: string,
        @Param('versionId') versionId: string,
    ) {
        return this.recipesService.getRecipeVersionFormTemplate(user.tenantId, familyId, versionId);
    }

    /**
     * [核心新增] 激活一个指定的配方版本
     * @param user
     * @param familyId
     * @param versionId
     * @returns
     */
    @Patch(':familyId/versions/:versionId/activate')
    activateVersion(
        @GetUser() user: UserPayload,
        @Param('familyId') familyId: string,
        @Param('versionId') versionId: string,
    ) {
        return this.recipesService.activateVersion(user.tenantId, familyId, versionId);
    }

    /**
     * [新增] 删除一个指定的配方版本
     * @param user
     * @param familyId
     * @param versionId
     */
    @Delete(':familyId/versions/:versionId')
    deleteVersion(
        @GetUser() user: UserPayload,
        @Param('familyId') familyId: string,
        @Param('versionId') versionId: string,
    ) {
        return this.recipesService.deleteVersion(user.tenantId, familyId, versionId);
    }

    /**
     * 获取当前租户的所有配方族（及其激活版本）。
     */
    @Get()
    findAll(@GetUser() user: UserPayload) {
        const tenantId = user.tenantId;
        return this.recipesService.findAll(tenantId);
    }

    /**
     * [核心新增] 获取用于创建生产任务的产品列表，按配方分组
     */
    @Get('products-for-tasks')
    findProductsForTasks(@GetUser() user: UserPayload) {
        const tenantId = user.tenantId;
        return this.recipesService.findProductsForTasks(tenantId);
    }

    /**
     * [核心修复] 修正 findOne 方法的调用
     * 根据配方族ID获取配方的详细信息，包含所有版本。
     * @param id 配方族ID
     */
    @Get(':id')
    async findOne(@Param('id') id: string) {
        // [修复] 调用 service 的 findOne 方法时只传递一个参数
        const recipe = await this.recipesService.findOne(id);
        if (!recipe) {
            throw new NotFoundException(`ID为 ${id} 的配方未找到`);
        }
        return recipe;
    }

    /**
     * [V2.5 修改] 物理删除一个配方族 (如果未被使用)。
     * @param id 配方族ID
     */
    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.recipesService.remove(id);
    }

    /**
     * [V2.5 新增] 弃用一个配方族 (软删除)。
     * @param id 配方族ID
     */
    @Patch(':id/discontinue')
    discontinue(@Param('id') id: string) {
        return this.recipesService.discontinue(id);
    }

    /**
     * [V2.5 新增] 恢复一个已弃用的配方族。
     * @param id 配方族ID
     */
    @Patch(':id/restore')
    restore(@Param('id') id: string) {
        return this.recipesService.restore(id);
    }
}
