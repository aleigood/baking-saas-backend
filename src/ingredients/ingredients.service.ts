/**
 * 文件路径: src/ingredients/ingredients.service.ts
 * 文件描述: 处理所有与原料相关的数据库操作和业务逻辑。
 */
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';

@Injectable()
export class IngredientsService {
  constructor(private prisma: PrismaService) {}

  /**
   * 创建一个新的原料品类 (如 "高筋粉")
   * @param createIngredientDto - 包含原料名称和含水率的DTO
   * @param user - 当前用户信息
   */
  async createIngredient(
    createIngredientDto: CreateIngredientDto,
    user: UserPayload,
  ) {
    return this.prisma.ingredient.create({
      data: {
        ...createIngredientDto,
        tenantId: user.tenantId,
      },
    });
  }

  /**
   * 为指定的原料品类添加一个新的SKU (如为“高筋粉”添加“王后5kg装”)
   * @param ingredientId - 原料品类的ID
   * @param createSkuDto - 包含品牌、规格等信息的DTO
   * @param user - 当前用户信息
   */
  async createSku(
    ingredientId: string,
    createSkuDto: CreateSkuDto,
    user: UserPayload,
  ) {
    // 安全检查：确保操作的原料品类属于当前租户
    await this.validateIngredientOwnership(ingredientId, user.tenantId);

    return this.prisma.ingredientSKU.create({
      data: {
        ...createSkuDto,
        ingredientId: ingredientId,
      },
    });
  }

  /**
   * 为指定的SKU添加入库（采购）记录
   * @param skuId - SKU的ID
   * @param createProcurementDto - 包含采购数量和单价的DTO
   * @param user - 当前用户信息
   */
  async createProcurement(
    skuId: string,
    createProcurementDto: CreateProcurementDto,
    user: UserPayload,
  ) {
    // 安全检查：确保操作的SKU属于当前租户
    const sku = await this.prisma.ingredientSKU.findUnique({
      where: { id: skuId },
      select: { ingredient: { select: { tenantId: true } } },
    });
    if (!sku || sku.ingredient.tenantId !== user.tenantId) {
      throw new ForbiddenException('您无权操作此SKU');
    }

    return this.prisma.procurementRecord.create({
      data: {
        ...createProcurementDto,
        skuId: skuId,
      },
    });
  }

  /**
   * 获取当前租户的所有原料品类及其总库存
   * @param user - 当前用户信息
   */
  async findAll(user: UserPayload) {
    const ingredients = await this.prisma.ingredient.findMany({
      where: { tenantId: user.tenantId },
      include: {
        skus: {
          include: {
            procurementRecords: true,
          },
        },
        // 注意：消耗记录的计算将在制作模块完成后加入
      },
    });

    // 在内存中计算每个原料品类的总库存
    return ingredients.map((ingredient) => {
      let totalStockInGrams = 0;
      ingredient.skus.forEach((sku) => {
        sku.procurementRecords.forEach((record) => {
          totalStockInGrams += record.packagesPurchased * sku.specWeightInGrams;
        });
      });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { skus, ...rest } = ingredient; // 从返回结果中移除详细的SKU列表，保持列表接口的简洁性
      return { ...rest, totalStockInGrams };
    });
  }

  /**
   * 辅助方法：验证原料品类是否属于指定租户
   */
  private async validateIngredientOwnership(
    ingredientId: string,
    tenantId: string,
  ) {
    const ingredient = await this.prisma.ingredient.findUnique({
      where: { id: ingredientId },
    });
    if (!ingredient) {
      throw new NotFoundException(`ID为 ${ingredientId} 的原料不存在`);
    }
    if (ingredient.tenantId !== tenantId) {
      throw new ForbiddenException('您无权操作此原料');
    }
  }
}
