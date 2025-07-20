import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemberDto } from './dto/member.dto';

@Injectable()
export class MembersService {
  constructor(private prisma: PrismaService) {}

  async findAllForTenant(tenantId: string): Promise<MemberDto[]> {
    const tenantUsers = await this.prisma.tenantUser.findMany({
      where: { tenantId, status: 'ACTIVE' },
      include: { user: true },
    });

    return tenantUsers.map((tu) => ({
      id: tu.user.id,
      name: tu.user.name,
      role: tu.role,
      joinDate: tu.createdAt.toISOString().split('T')[0],
    }));
  }
}
