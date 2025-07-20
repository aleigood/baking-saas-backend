import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';

@Injectable()
export class IngredientsService {
  constructor(private prisma: PrismaService) {}

  create(createIngredientDto: CreateIngredientDto, tenantId: string) {
    return this.prisma.ingredient.create({
      data: {
        ...createIngredientDto,
        tenantId,
      },
    });
  }

  // [核心更新] 获取指定店铺的原料列表
  async findAllForTenant(tenantId: string) {
    const ingredients = await this.prisma.ingredient.findMany({
      where: { tenantId },
      include: { skus: true },
    });

    // 映射数据以匹配前端期望的格式
    return ingredients.map((i) => ({
      id: i.id,
      name: i.name,
      brand: i.skus[0]?.brand || 'N/A', // 取第一个SKU的品牌作为代表
      price: 10.0, // 注意：此为模拟数据，真实价格需从采购记录计算
      stock: 100, // 注意：此为模拟数据，真实库存需通过采购和消耗记录计算
    }));
  }

  createSku(ingredientId: string, createSkuDto: CreateSkuDto) {
    return this.prisma.ingredientSKU.create({
      data: {
        ingredientId,
        ...createSkuDto,
      },
    });
  }

  createProcurement(createProcurementDto: CreateProcurementDto) {
    const { skuId, ...restData } = createProcurementDto;
    return this.prisma.procurementRecord.create({
      data: {
        ...restData,
        sku: {
          connect: {
            id: skuId,
          },
        },
      },
    });
  }
}
