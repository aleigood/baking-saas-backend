/**
 * 文件路径: src/members/members.service.ts
 * 文件描述: (功能完善) 实现了角色变更和软删除的业务逻辑及权限校验。
 */
import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemberDto } from './dto/member.dto';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { Role, UserStatusInTenant } from '@prisma/client';

@Injectable()
export class MembersService {
  constructor(private prisma: PrismaService) {}

  async findAllForTenant(tenantId: string): Promise<MemberDto[]> {
    const tenantUsers = await this.prisma.tenantUser.findMany({
      where: { tenantId, status: 'ACTIVE' }, // 只查询在职员工
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });

    return tenantUsers.map((tu) => ({
      id: tu.user.id,
      name: tu.user.name,
      role: tu.role,
      joinDate: tu.createdAt.toISOString().split('T')[0],
    }));
  }

  /**
   * [新增] 更新成员角色
   * @param memberId 要更新的成员ID
   * @param newRole 新的角色
   * @param currentUser 发起操作的用户
   */
  async updateRole(memberId: string, newRole: Role, currentUser: UserPayload) {
    const {
      tenantId,
      role: currentUserRole,
      userId: currentUserId,
    } = currentUser;

    // 校验：用户不能修改自己的角色
    if (memberId === currentUserId) {
      throw new ForbiddenException('You cannot change your own role.');
    }

    const memberToUpdate = await this.prisma.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId, userId: memberId } },
    });

    if (!memberToUpdate) {
      throw new NotFoundException('Member not found in this tenant.');
    }

    // --- 权限校验逻辑 ---
    if (currentUserRole === Role.BAKER) {
      throw new ForbiddenException('Bakers cannot change roles.');
    }
    if (currentUserRole === Role.MANAGER) {
      // 主管只能管理面包师，且不能将会面包师提升为平级或更高级别
      if (memberToUpdate.role !== Role.BAKER || newRole !== Role.BAKER) {
        throw new ForbiddenException('Managers can only manage Bakers.');
      }
    }
    // 老板(OWNER)拥有所有权限，无需额外校验

    return this.prisma.tenantUser.update({
      where: { tenantId_userId: { tenantId, userId: memberId } },
      data: { role: newRole },
    });
  }

  /**
   * [新增] 软删除一个成员 (将其状态设为 INACTIVE)
   * @param memberId 要删除的成员ID
   * @param currentUser 发起操作的用户
   */
  async remove(memberId: string, currentUser: UserPayload) {
    const {
      tenantId,
      role: currentUserRole,
      userId: currentUserId,
    } = currentUser;

    // 校验：用户不能删除自己
    if (memberId === currentUserId) {
      throw new ForbiddenException('You cannot remove yourself.');
    }

    const memberToRemove = await this.prisma.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId, userId: memberId } },
    });

    if (!memberToRemove) {
      throw new NotFoundException('Member not found in this tenant.');
    }

    // --- 权限校验逻辑 ---
    if (currentUserRole === Role.BAKER) {
      throw new ForbiddenException('Bakers cannot remove members.');
    }
    if (
      currentUserRole === Role.MANAGER &&
      memberToRemove.role !== Role.BAKER
    ) {
      throw new ForbiddenException('Managers can only remove Bakers.');
    }
    // 老板(OWNER)可以删除主管和面包师

    return this.prisma.tenantUser.update({
      where: { tenantId_userId: { tenantId, userId: memberId } },
      data: { status: UserStatusInTenant.INACTIVE },
    });
  }
}
