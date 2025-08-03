import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';
import { UpdateMemberDto } from './dto/update-member.dto';
import { UserPayload } from 'src/auth/interfaces/user-payload.interface';

@Injectable()
export class MembersService {
  constructor(private prisma: PrismaService) {}

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
      throw new NotFoundException('该成员不存在');
    }

    const { user, ...rest } = tenantUser;
    return { ...rest, ...user };
  }

  async update(
    tenantId: string,
    memberId: string,
    dto: UpdateMemberDto,
    currentUser: UserPayload,
  ) {
    const memberToUpdate = await this.findOne(tenantId, memberId);

    if (currentUser.role === Role.MEMBER) {
      throw new ForbiddenException('您没有权限修改成员信息。');
    }
    if (currentUser.role === Role.ADMIN) {
      if (
        memberToUpdate.role === Role.ADMIN ||
        memberToUpdate.role === Role.OWNER
      ) {
        throw new ForbiddenException('管理员不能修改其他管理员或所有者。');
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

  async remove(tenantId: string, memberId: string, currentUser: UserPayload) {
    const memberToRemove = await this.findOne(tenantId, memberId);

    if (memberToRemove.role === Role.OWNER) {
      throw new ForbiddenException('不能移除店铺所有者。');
    }

    if (
      currentUser.role === Role.MEMBER ||
      (currentUser.role === Role.ADMIN && memberToRemove.role === Role.ADMIN)
    ) {
      throw new ForbiddenException('您没有权限移除该成员。');
    }

    return this.prisma.tenantUser.delete({
      where: {
        userId_tenantId: { tenantId, userId: memberId },
      },
    });
  }
}
