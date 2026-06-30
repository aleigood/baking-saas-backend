// G-Code-Note: Controller (NestJS)
// 路径: src/recipes/recipes.controller.ts
// [核心修改] 修复 Prettier 格式问题，并将 'exportRecipes' 的权限检查移至 Service

import { Controller, Get, Post, Body, Param, Delete, UseGuards, NotFoundException, Patch } from '@nestjs/common';
import { RecipesService } from './recipes.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { UpdateRecipeVersionNotesDto } from './dto/update-recipe-version-notes.dto';

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
        return this.recipesService.create(tenantId, user.sub, createRecipeDto);
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
        return this.recipesService.createVersion(tenantId, familyId, user.sub, createRecipeDto);
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
        return this.recipesService.updateVersion(tenantId, familyId, versionId, user.sub, updateRecipeDto);
    }

    @Patch(':familyId/versions/:versionId/notes')
    updateVersionNotes(
        @GetUser() user: UserPayload,
        @Param('familyId') familyId: string,
        @Param('versionId') versionId: string,
        @Body() dto: UpdateRecipeVersionNotesDto,
    ) {
        return this.recipesService.updateVersionNotes(user.tenantId, familyId, versionId, user.sub, dto.notes);
    }

    @Get(':familyId/operation-logs')
    getOperationLogs(@GetUser() user: UserPayload, @Param('familyId') familyId: string) {
        return this.recipesService.getOperationLogs(user.tenantId, familyId);
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

    @Get(':familyId/versions/:versionId/dependency-upgrades')
    getDependencyUpgradePlan(
        @GetUser() user: UserPayload,
        @Param('familyId') familyId: string,
        @Param('versionId') versionId: string,
    ) {
        return this.recipesService.getDependencyUpgradePlan(user.tenantId, familyId, versionId);
    }

    @Post(':familyId/versions/:versionId/dependency-upgrades/apply')
    applyDependencyUpgrades(
        @GetUser() user: UserPayload,
        @Param('familyId') familyId: string,
        @Param('versionId') versionId: string,
    ) {
        return this.recipesService.applyDependencyUpgrades(user.tenantId, familyId, versionId, user.sub);
    }

    @Get(':familyId/pending-dependency-upgrades')
    getPendingDependencyUpgrades(@GetUser() user: UserPayload, @Param('familyId') familyId: string) {
        return this.recipesService.getPendingDependencyUpgrades(user.tenantId, familyId);
    }

    @Post(':familyId/pending-dependency-upgrades/apply')
    applyPendingDependencyUpgrades(@GetUser() user: UserPayload, @Param('familyId') familyId: string) {
        return this.recipesService.applyPendingDependencyUpgrades(user.tenantId, familyId, user.sub);
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
        return this.recipesService.activateVersion(user.tenantId, familyId, versionId, user.sub);
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
    async findOne(@GetUser() user: UserPayload, @Param('id') id: string) {
        const recipe = await this.recipesService.findOne(user.tenantId, id);
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
    remove(@GetUser() user: UserPayload, @Param('id') id: string) {
        return this.recipesService.remove(user.tenantId, id);
    }

    /**
     * [V2.5 新增] 弃用一个配方族 (软删除)。
     * @param id 配方族ID
     */
    @Patch(':id/discontinue')
    discontinue(@GetUser() user: UserPayload, @Param('id') id: string) {
        return this.recipesService.discontinue(user.tenantId, id, user.sub);
    }

    /**
     * [V2.5 新增] 恢复一个已弃用的配方族。
     * @param id 配方族ID
     */
    @Patch(':id/restore')
    restore(@GetUser() user: UserPayload, @Param('id') id: string) {
        return this.recipesService.restore(user.tenantId, id, user.sub);
    }
}

// [G-Code-Note] 修复 Prettier 格式：文件末尾添加空行
