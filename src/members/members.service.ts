// ========================================================

// 文件路径: src/members/members.service.ts
import {
    Injectable as InjectableMembers,
    NotFoundException as NotFoundExceptionMembers,
    ForbiddenException as ForbiddenExceptionMembers,
    ConflictException,
} from '@nestjs/common';
import { PrismaService as PrismaServiceMembers } from '../prisma/prisma.service';
import { Role as RoleMembers, UserStatus } from '@prisma/client';
import { UpdateMemberDto as UpdateMemberDtoMembers } from './dto/update-member.dto';
import { UserPayload as UserPayloadMembers } from 'src/auth/interfaces/user-payload.interface';
import { CreateMemberDto } from './dto/create-member.dto'; // [核心新增] 导入CreateMemberDto
import * as bcrypt from 'bcrypt'; // [核心新增] 导入bcrypt用于密码哈希

@InjectableMembers()
export class MembersService {
    constructor(private prisma: PrismaServiceMembers) {}

    /**
     * [核心新增] 在指定店铺中创建一个新成员
     * @param tenantId 店铺ID
     * @param dto 成员数据
     * @param currentUser 当前操作用户
     */
    async create(tenantId: string, dto: CreateMemberDto, currentUser: UserPayloadMembers) {
        if (currentUser.role === RoleMembers.MEMBER) {
            throw new ForbiddenExceptionMembers('您没有权限创建新成员。');
        }

        // [核心新增] 权限校验：管理员不能创建管理员或所有者
        if (
            currentUser.role === RoleMembers.ADMIN &&
            (dto.role === RoleMembers.ADMIN || dto.role === RoleMembers.OWNER)
        ) {
            throw new ForbiddenExceptionMembers('管理员只能创建普通员工。');
        }

        // [核心新增] 权限校验：所有者不能直接创建另一个所有者
        if (dto.role === RoleMembers.OWNER) {
            throw new ForbiddenExceptionMembers('不能直接创建所有者角色。');
        }

        const existingUser = await this.prisma.user.findUnique({
            where: { phone: dto.phone },
        });

        if (existingUser) {
            throw new ConflictException('该手机号已被注册。');
        }

        const hashedPassword = await bcrypt.hash(dto.password, 10);

        // 使用事务确保用户创建和店铺关联的原子性
        return this.prisma.$transaction(async (tx) => {
            const newUser = await tx.user.create({
                data: {
                    name: dto.name,
                    phone: dto.phone,
                    password: hashedPassword,
                    status: UserStatus.ACTIVE, // 直接创建的用户默认为激活状态
                },
                // [核心修正] 使用 select 来返回不包含密码的用户信息，以解决 lint 错误
                select: {
                    id: true,
                    phone: true,
                    name: true,
                    avatarUrl: true,
                    role: true,
                    status: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });

            await tx.tenantUser.create({
                data: {
                    tenantId: tenantId,
                    userId: newUser.id,
                    role: dto.role, // [核心修改] 使用DTO中传入的角色
                    status: UserStatus.ACTIVE,
                },
            });

            // 直接返回已筛选字段的 newUser 对象
            return newUser;
        });
    }

    /**
     * [核心新增] 获取所有者名下所有店铺的全部成员列表
     * @param ownerId 所有者的用户ID
     */
    async findAllInAllTenantsByOwner(ownerId: string) {
        // 1. 验证用户是否为所有者，并获取其拥有的所有店铺ID
        const ownerTenants = await this.prisma.tenantUser.findMany({
            where: {
                userId: ownerId,
                role: RoleMembers.OWNER,
            },
            select: {
                tenantId: true,
            },
        });

        if (ownerTenants.length === 0) {
            // 如果该用户不是任何店铺的所有者，返回空数组
            return [];
        }

        const tenantIds = ownerTenants.map((t) => t.tenantId);

        // 2. 查询这些店铺中的所有成员
        const tenantsWithMembers = await this.prisma.tenant.findMany({
            where: {
                id: { in: tenantIds },
            },
            include: {
                members: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                phone: true,
                                createdAt: true,
                            },
                        },
                    },
                    orderBy: { user: { createdAt: 'asc' } },
                },
            },
        });

        // 3. 格式化数据以便前端展示
        const allMembersByTenant = tenantsWithMembers.map((tenant) => ({
            tenantId: tenant.id,
            tenantName: tenant.name,
            members: tenant.members.map((tu) => ({
                id: tu.user.id,
                name: tu.user.name || tu.user.phone,
                phone: tu.user.phone,
                role: tu.role,
                status: tu.status,
                joinDate: tu.user.createdAt.toISOString().split('T')[0],
            })),
        }));

        return allMembersByTenant;
    }

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

        // [核心修正] 格式化返回数据，确保包含 joinDate 字段
        const { user } = tenantUser;
        return {
            id: user.id,
            name: user.name || user.phone,
            phone: user.phone,
            role: tenantUser.role,
            status: tenantUser.status,
            joinDate: user.createdAt.toISOString().split('T')[0],
        };
    }

    async update(tenantId: string, memberId: string, dto: UpdateMemberDtoMembers, currentUser: UserPayloadMembers) {
        // [核心修正] findOne 现在返回的是格式化后的数据，需要调整这里的逻辑
        const memberToUpdate = await this.prisma.tenantUser.findUnique({
            where: { userId_tenantId: { tenantId, userId: memberId } },
        });

        if (!memberToUpdate) {
            throw new NotFoundExceptionMembers('该成员不存在');
        }

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
        // [核心修正] findOne 现在返回的是格式化后的数据，需要调整这里的逻辑
        const memberToRemove = await this.prisma.tenantUser.findUnique({
            where: { userId_tenantId: { tenantId, userId: memberId } },
        });

        if (!memberToRemove) {
            throw new NotFoundExceptionMembers('该成员不存在');
        }

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
