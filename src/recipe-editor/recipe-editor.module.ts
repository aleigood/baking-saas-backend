import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RecipesModule } from '../recipes/recipes.module';
import { IngredientsModule } from '../ingredients/ingredients.module';
import { RecipeEditorController } from './recipe-editor.controller';
import { RecipeEditorService } from './recipe-editor.service';
import { RecipeImportModelProvider } from '../recipe-import/recipe-import.provider';
import { RECIPE_IMPORT_EDITOR_CONTEXT, RecipeImportService } from '../recipe-import/recipe-import.service';

@Module({
    imports: [PrismaModule, RecipesModule, IngredientsModule],
    controllers: [RecipeEditorController],
    providers: [
        RecipeEditorService,
        RecipeImportModelProvider,
        RecipeImportService,
        { provide: RECIPE_IMPORT_EDITOR_CONTEXT, useExisting: RecipeEditorService },
    ],
    exports: [RecipeEditorService],
})
export class RecipeEditorModule {}
