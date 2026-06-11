import { Module } from '@nestjs/common';
import { IngredientsController } from './ingredients.controller';
import { IngredientsService } from './ingredients.service';
import { CostingModule } from '../costing/costing.module';

@Module({
    imports: [CostingModule],
    controllers: [IngredientsController],
    providers: [IngredientsService],
})
export class IngredientsModule {}
