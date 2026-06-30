import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { SuperAdminGuard } from '../super-admin/guards/super-admin.guard';
import { RecipeEditorService } from './recipe-editor.service';
import {
    ApproveRecipeEditorCodeDto,
    ApproveRecipeEditorSessionDto,
    UpsertRecipeDraftDto,
} from './dto/recipe-editor.dto';

@Controller('recipe-editor')
export class RecipeEditorController {
    constructor(private readonly recipeEditorService: RecipeEditorService) {}

    @Post('sessions')
    createLoginSession() {
        return this.recipeEditorService.createLoginSession();
    }

    @Get('sessions/:id')
    getSessionStatus(@Param('id') id: string, @Query('token') token: string) {
        return this.recipeEditorService.getSessionStatus(id, token);
    }

    @Post('sessions/:id/approve')
    @UseGuards(AuthGuard('jwt'))
    approveSession(@GetUser() user: UserPayload, @Param('id') id: string, @Body() dto: ApproveRecipeEditorSessionDto) {
        return this.recipeEditorService.approveSession(id, dto.token, user.sub, user.tenantId, user.tenantRole);
    }

    @Post('sessions/approve-code')
    @UseGuards(AuthGuard('jwt'))
    approveSessionByCode(@GetUser() user: UserPayload, @Body() dto: ApproveRecipeEditorCodeDto) {
        return this.recipeEditorService.approveSessionByCode(dto.code, user.sub, user.tenantId, user.tenantRole);
    }

    @Post('admin/tenants/:tenantId/sessions')
    @UseGuards(AuthGuard('jwt'), SuperAdminGuard)
    createAdminSession(@GetUser() user: UserPayload, @Param('tenantId') tenantId: string) {
        return this.recipeEditorService.createAdminSession(tenantId, user.sub);
    }

    @Post('sessions/:id/exchange')
    exchangeSessionToken(@Param('id') id: string, @Body() dto: ApproveRecipeEditorSessionDto) {
        return this.recipeEditorService.exchangeSessionToken(id, dto.token);
    }

    @Post('heartbeat')
    heartbeat(@Headers('x-editor-session-id') sessionId: string, @Headers('x-editor-token') token: string) {
        return this.recipeEditorService.heartbeat(sessionId, token);
    }

    @Get('me')
    getEditorMe(@Headers('x-editor-session-id') sessionId: string, @Headers('x-editor-token') token: string) {
        return this.recipeEditorService.getEditorMe(sessionId, token);
    }

    @Get('drafts')
    listDrafts(@Headers('x-editor-session-id') sessionId: string, @Headers('x-editor-token') token: string) {
        return this.recipeEditorService.listDrafts(sessionId, token);
    }

    @Get('recipes')
    listRecipes(@Headers('x-editor-session-id') sessionId: string, @Headers('x-editor-token') token: string) {
        return this.recipeEditorService.listRecipes(sessionId, token);
    }

    @Get('ingredients')
    listIngredients(@Headers('x-editor-session-id') sessionId: string, @Headers('x-editor-token') token: string) {
        return this.recipeEditorService.listIngredients(sessionId, token);
    }

    @Post('drafts')
    createDraft(
        @Headers('x-editor-session-id') sessionId: string,
        @Headers('x-editor-token') token: string,
        @Body() dto: UpsertRecipeDraftDto,
    ) {
        return this.recipeEditorService.createDraft(sessionId, token, dto);
    }

    @Patch('drafts/:draftId')
    updateDraft(
        @Headers('x-editor-session-id') sessionId: string,
        @Headers('x-editor-token') token: string,
        @Param('draftId') draftId: string,
        @Body() dto: UpsertRecipeDraftDto,
    ) {
        return this.recipeEditorService.updateDraft(sessionId, token, draftId, dto);
    }

    @Post('drafts/:draftId/sync')
    syncDraft(
        @Headers('x-editor-session-id') sessionId: string,
        @Headers('x-editor-token') token: string,
        @Param('draftId') draftId: string,
    ) {
        return this.recipeEditorService.syncDraft(sessionId, token, draftId);
    }

    @Post('sessions/:id/close')
    closeSession(@Param('id') id: string, @Headers('x-editor-token') token: string) {
        return this.recipeEditorService.closeSession(id, token);
    }
}
