import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantDataDto } from './dto/tenant-data.dto';

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
}
