import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { SetDefaultSkuDto } from './dto/set-default-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';

@Injectable()
export class IngredientsService {
  constructor(private prisma: PrismaService) {}

  // --- Ingredient (原料品类) Management ---

  async createIngredient(tenantId: string, dto: CreateIngredientDto) {
    return this.prisma.ingredient.create({
      data: {
        tenantId,
        name: dto.name,
        type: dto.type,
      },
    });
  }

  async findAllIngredients(tenantId: string) {
    return this.prisma.ingredient.findMany({
      where: { tenantId, deletedAt: null },
      include: {
        skus: true,
        defaultSku: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOneIngredient(tenantId: string, id: string) {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: { skus: true, defaultSku: true },
    });
    if (!ingredient) {
      throw new NotFoundException(`ID为 ${id} 的原料不存在。`);
    }
    return ingredient;
  }

  async updateIngredient(
    tenantId: string,
    id: string,
    dto: UpdateIngredientDto,
  ) {
    await this.findOneIngredient(tenantId, id);
    // 修复：直接传递修复后的、类型安全的DTO
    return this.prisma.ingredient.update({
      where: { id },
      data: dto,
    });
  }

  async removeIngredient(tenantId: string, id: string) {
    await this.findOneIngredient(tenantId, id);
    return this.prisma.ingredient.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // --- IngredientSKU (商品规格) Management ---

  async createSku(tenantId: string, ingredientId: string, dto: CreateSkuDto) {
    await this.findOneIngredient(tenantId, ingredientId);
    return this.prisma.ingredientSKU.create({
      data: {
        ingredientId,
        brand: dto.brand,
        specName: dto.specName,
        specWeightInGrams: dto.specWeightInGrams,
      },
    });
  }

  async setDefaultSku(
    tenantId: string,
    ingredientId: string,
    dto: SetDefaultSkuDto,
  ) {
    await this.findOneIngredient(tenantId, ingredientId);
    const sku = await this.prisma.ingredientSKU.findFirst({
      where: { id: dto.skuId, ingredientId: ingredientId },
    });
    if (!sku) {
      throw new NotFoundException(
        `ID为 ${dto.skuId} 的SKU不存在或不属于该原料。`,
      );
    }

    return this.prisma.ingredient.update({
      where: { id: ingredientId },
      data: { defaultSkuId: dto.skuId },
    });
  }

  // --- Procurement (采购) Management ---

  async createProcurement(tenantId: string, dto: CreateProcurementDto) {
    const { skuId, packagesPurchased, pricePerPackage, purchaseDate } = dto;

    const sku = await this.prisma.ingredientSKU.findFirst({
      where: {
        id: skuId,
        ingredient: {
          tenantId: tenantId,
        },
      },
    });

    if (!sku) {
      throw new NotFoundException(`ID为 ${skuId} 的SKU不存在或不属于该租户。`);
    }

    return this.prisma.procurementRecord.create({
      data: {
        skuId,
        packagesPurchased,
        pricePerPackage,
        purchaseDate: new Date(purchaseDate),
      },
    });
  }
}
