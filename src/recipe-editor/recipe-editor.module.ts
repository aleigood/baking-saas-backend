import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RecipesModule } from '../recipes/recipes.module';
import { IngredientsModule } from '../ingredients/ingredients.module';
import { RecipeEditorController } from './recipe-editor.controller';
import { RecipeEditorService } from './recipe-editor.service';

@Module({
    imports: [PrismaModule, RecipesModule, IngredientsModule],
    controllers: [RecipeEditorController],
    providers: [RecipeEditorService],
    exports: [RecipeEditorService],
})
export class RecipeEditorModule {}
