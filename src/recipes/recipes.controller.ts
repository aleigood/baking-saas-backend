import { Controller, Get, Post, Body, Param, Delete, UseGuards, NotFoundException, Patch } from '@nestjs/common'; // [修改] 引入 Patch
import { RecipesService } from './recipes.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@UseGuards(AuthGuard('jwt'))
@Controller('recipes')
export class RecipesController {
    constructor(private readonly recipesService: RecipesService) {}

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
     * 获取当前租户的所有配方族（及其激活版本）。
     */
    @Get()
    findAll(@GetUser() user: UserPayload) {
        const tenantId = user.tenantId;
        return this.recipesService.findAll(tenantId);
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
     * 软删除一个配方族。
     * @param id 配方族ID
     */
    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.recipesService.remove(id);
    }
}
