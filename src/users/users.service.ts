import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import * as bcrypt from 'bcrypt';
import { getUserDisplayName } from '../common/utils/user-display.util';
import { getAvatarIdFromPath, getAvatarPath, listAvatarOptions } from './avatar-catalog';

@Injectable()
export class UsersService {
    constructor(private prisma: PrismaService) {}

    listAvatars() {
        return listAvatarOptions();
    }

    async updateProfile(userId: string, updateProfileDto: UpdateProfileDto) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            throw new NotFoundException('用户不存在');
        }

        const updatedUser = await this.prisma.user.update({
            where: { id: userId },
            data: {
                wechatNickname:
                    updateProfileDto.wechatNickname === undefined
                        ? undefined
                        : updateProfileDto.wechatNickname.trim() || null,
                avatarUrl: updateProfileDto.avatarId ? getAvatarPath(updateProfileDto.avatarId) : undefined,
            },
            select: {
                id: true,
                phone: true,
                phoneVerifiedAt: true,
                name: true,
                wechatNickname: true,
                avatarUrl: true,
                globalRole: true,
                status: true,
                createdAt: true,
            },
        });
        return {
            ...updatedUser,
            avatarId: getAvatarIdFromPath(updatedUser.avatarUrl),
            displayName: getUserDisplayName(updatedUser),
        };
    }

    async changePassword(userId: string, changePasswordDto: ChangePasswordDto) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            throw new NotFoundException('用户不存在');
        }
        if (!user.password) {
            throw new UnauthorizedException('当前账号尚未设置密码，请先完成手机号和密码绑定');
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
