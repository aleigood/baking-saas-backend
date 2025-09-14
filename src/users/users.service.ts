import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
    constructor(private prisma: PrismaService) {}

    async updateProfile(userId: string, updateProfileDto: UpdateProfileDto) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            throw new NotFoundException('用户不存在');
        }

        return this.prisma.user.update({
            where: { id: userId },
            data: {
                name: updateProfileDto.name,
                avatarUrl: updateProfileDto.avatarUrl,
            },
            select: {
                id: true,
                phone: true,
                name: true,
                avatarUrl: true,
                role: true,
                status: true,
                createdAt: true,
            },
        });
    }

    async changePassword(userId: string, changePasswordDto: ChangePasswordDto) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            throw new NotFoundException('用户不存在');
        }

        const isPasswordMatching = await bcrypt.compare(changePasswordDto.currentPassword, user.password);
        if (!isPasswordMatching) {
            throw new UnauthorizedException('当前密码不正确');
        }

        const hashedNewPassword = await bcrypt.hash(changePasswordDto.newPassword, 10);

        await this.prisma.user.update({
            where: { id: userId },
            data: { password: hashedNewPassword },
        });

        return { message: '密码修改成功' };
    }
}
