import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantDataDto } from './dto/tenant-data.dto';
import { Role } from '@prisma/client';

@Injectable()
export class TenantsService {
    constructor(private prisma: PrismaService) {}

    /**
     * 查找指定用户所属的所有租户
     * @param userId 用户的ID
     * @returns 租户列表
     */
    async findAllForUser(userId: string) {
        // 修复：通过 TenantUser 中间表进行查询
        return this.prisma.tenant.findMany({
            where: {
                members: {
                    some: {
                        userId: userId,
                    },
                },
            },
        });
    }

    /**
     * 为指定用户创建一个新的租户
     * @param userId 创建者的用户ID
     * @param tenantData 租户的名称等数据
     * @returns 创建的租户信息
     */
    async create(userId: string, tenantData: TenantDataDto) {
        // 修复：在创建租户的同时，将创建者设为该租户的 OWNER
        return this.prisma.tenant.create({
            data: {
                name: tenantData.name,
                members: {
                    create: {
                        userId: userId,
                        role: 'OWNER', // 创建者默认为所有者
                        status: 'ACTIVE',
                    },
                },
            },
        });
    }

    /**
     * [核心新增] 更新一个租户的信息
     * @param tenantId 要更新的租户ID
     * @param userId 操作用户的ID
     * @param tenantData 要更新的数据
     * @returns 更新后的租户信息
     */
    async update(tenantId: string, userId: string, tenantData: Partial<TenantDataDto>) {
        const tenantUser = await this.prisma.tenantUser.findUnique({
            where: {
                userId_tenantId: {
                    userId,
                    tenantId,
                },
            },
        });

        if (!tenantUser || tenantUser.role !== Role.OWNER) {
            throw new ForbiddenException('只有店铺所有者才能修改店铺信息。');
        }

        return this.prisma.tenant.update({
            where: { id: tenantId },
            data: tenantData,
        });
    }
}
