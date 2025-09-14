// ========================================================

// 文件路径: src/members/members.service.ts
import {
    Injectable as InjectableMembers,
    NotFoundException as NotFoundExceptionMembers,
    ForbiddenException as ForbiddenExceptionMembers,
} from '@nestjs/common';
import { PrismaService as PrismaServiceMembers } from '../prisma/prisma.service';
import { Role as RoleMembers } from '@prisma/client';
import { UpdateMemberDto as UpdateMemberDtoMembers } from './dto/update-member.dto';
import { UserPayload as UserPayloadMembers } from 'src/auth/interfaces/user-payload.interface';

@InjectableMembers()
export class MembersService {
    constructor(private prisma: PrismaServiceMembers) {}

    /**
     * [核心新增] 检查并返回所有者有权访问的目标租户ID
     * @param currentUser 当前用户
     * @param requestedTenantId 请求的租户ID
     * @returns 最终用于查询的租户ID
     */
    getTargetTenantIdForOwner(currentUser: UserPayloadMembers, requestedTenantId?: string): string {
        // 如果用户是所有者并且提供了一个租户ID，则使用该ID
        if (currentUser.role === RoleMembers.OWNER && requestedTenantId) {
            // 在生产环境中，这里应该增加一步校验：
            // 确认 requestedTenantId 确实是该 currentUser 拥有的店铺之一
            return requestedTenantId;
        }
        // 对于任何其他情况（非所有者，或所有者未提供特定店铺ID），
        // 都默认使用他们当前登录的店铺ID
        return currentUser.tenantId;
    }

    async findAll(tenantId: string) {
        const tenantUsers = await this.prisma.tenantUser.findMany({
            where: { tenantId },
            include: {
                user: true,
            },
            orderBy: { user: { createdAt: 'asc' } },
        });

        return tenantUsers.map((tu) => ({
            id: tu.user.id,
            name: tu.user.name || tu.user.phone, // [修改] 优先返回姓名
            phone: tu.user.phone,
            role: tu.role,
            status: tu.status,
            joinDate: tu.user.createdAt.toISOString().split('T')[0],
        }));
    }

    async findOne(tenantId: string, memberId: string) {
        const tenantUser = await this.prisma.tenantUser.findUnique({
            where: {
                userId_tenantId: { tenantId, userId: memberId },
            },
            include: { user: true },
        });

        if (!tenantUser) {
            throw new NotFoundExceptionMembers('该成员不存在');
        }

        const { user, ...rest } = tenantUser;
        return { ...rest, ...user };
    }

    async update(tenantId: string, memberId: string, dto: UpdateMemberDtoMembers, currentUser: UserPayloadMembers) {
        const memberToUpdate = await this.findOne(tenantId, memberId);

        if (currentUser.role === RoleMembers.MEMBER) {
            throw new ForbiddenExceptionMembers('您没有权限修改成员信息。');
        }
        if (currentUser.role === RoleMembers.ADMIN) {
            if (memberToUpdate.role === RoleMembers.ADMIN || memberToUpdate.role === RoleMembers.OWNER) {
                throw new ForbiddenExceptionMembers('管理员不能修改其他管理员或所有者。');
            }
        }

        return this.prisma.tenantUser.update({
            where: {
                userId_tenantId: { tenantId, userId: memberId },
            },
            data: {
                role: dto.role,
                status: dto.status,
            },
        });
    }

    async remove(tenantId: string, memberId: string, currentUser: UserPayloadMembers) {
        const memberToRemove = await this.findOne(tenantId, memberId);

        if (memberToRemove.role === RoleMembers.OWNER) {
            throw new ForbiddenExceptionMembers('不能移除店铺所有者。');
        }

        if (
            currentUser.role === RoleMembers.MEMBER ||
            (currentUser.role === RoleMembers.ADMIN && memberToRemove.role === RoleMembers.ADMIN)
        ) {
            throw new ForbiddenExceptionMembers('您没有权限移除该成员。');
        }

        return this.prisma.tenantUser.delete({
            where: {
                userId_tenantId: { tenantId, userId: memberId },
            },
        });
    }
}
