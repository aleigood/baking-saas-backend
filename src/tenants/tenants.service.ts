import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TenantsService {
  constructor(private prisma: PrismaService) {}

  findAllForUser(userId: string) {
    return this.prisma.tenant.findMany({
      where: {
        users: {
          some: {
            userId: userId,
          },
        },
      },
    });
  }
}
