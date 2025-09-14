// 文件路径: src/auth/auth.service.ts
import {
    Injectable,
    UnauthorizedException,
    ConflictException,
    NotFoundException,
    NotImplementedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthDto, RegisterDto, WechatLoginDto, LoginResponseDto } from './dto/auth.dto'; // [核心修正] 更新导入
import * as bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import { JwtPayload } from './interfaces/jwt-payload.interface';
// [核心删除] 不再需要单独导入 LoginResponseDto

@Injectable()
export class AuthService {
    constructor(
        private prisma: PrismaService,
        private jwtService: JwtService,
    ) {}

    private generateJwtToken(
        userId: string,
        tenantId: string,
        roleInTenant: Role,
        globalRole?: Role,
    ): { accessToken: string } {
        const payload: JwtPayload = {
            sub: userId,
            tenantId,
            role: roleInTenant,
            globalRole,
        };
        return {
            accessToken: this.jwtService.sign(payload),
        };
    }

    async register(registerDto: RegisterDto): Promise<{ accessToken: string }> {
        const { name, phone, password, tenantName } = registerDto; // [修改] 解构出 name

        const existingUser = await this.prisma.user.findUnique({
            where: { phone },
        });
        if (existingUser) {
            throw new ConflictException('该手机号已被注册');
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const { user, tenantUser } = await this.prisma.$transaction(async (tx) => {
            const newUser = await tx.user.create({
                data: {
                    name, // [修改] 保存姓名
                    phone,
                    password: hashedPassword,
                },
            });

            const newTenant = await tx.tenant.create({
                data: {
                    name: tenantName,
                },
            });

            const newTenantUser = await tx.tenantUser.create({
                data: {
                    userId: newUser.id,
                    tenantId: newTenant.id,
                    role: Role.OWNER,
                    status: 'ACTIVE',
                },
            });

            return { user: newUser, tenantUser: newTenantUser };
        });

        return this.generateJwtToken(user.id, tenantUser.tenantId, tenantUser.role, user.role);
    }

    async login(loginDto: AuthDto): Promise<LoginResponseDto> {
        const user = await this.prisma.user.findUnique({
            where: { phone: loginDto.phone },
            include: {
                tenants: {
                    orderBy: { tenant: { createdAt: 'asc' } },
                },
            },
        });

        if (!user || !user.password || !(await bcrypt.compare(loginDto.password, user.password))) {
            throw new UnauthorizedException('手机号或密码错误');
        }

        if (user.role === Role.SUPER_ADMIN) {
            const token = this.generateJwtToken(user.id, '', user.role, user.role);
            return { accessToken: token.accessToken };
        }

        const firstTenantUser = user.tenants[0];
        if (!firstTenantUser) {
            throw new UnauthorizedException('用户不属于任何店铺，无法登录。');
        }

        const token = this.generateJwtToken(user.id, firstTenantUser.tenantId, firstTenantUser.role, user.role);

        // [核心修正] 如果用户在店铺中的角色是普通成员（即面包师），则添加重定向路径
        if (firstTenantUser.role === Role.MEMBER) {
            return {
                accessToken: token.accessToken,
                redirectTo: '/pages/baker/main',
            };
        }

        return { accessToken: token.accessToken };
    }

    loginByWechat(wechatLoginDto: WechatLoginDto): Promise<{ accessToken: string }> {
        console.log(wechatLoginDto); // 临时使用一下参数避免lint错误
        throw new NotImplementedException(
            '微信登录功能需要数据库模型支持 wechatOpenId 字段，并需实现code换取openid的后端逻辑。',
        );
    }

    async switchTenant(userId: string, tenantId: string): Promise<{ accessToken: string }> {
        const tenantUser = await this.prisma.tenantUser.findUnique({
            where: {
                userId_tenantId: { userId, tenantId },
            },
            include: { user: true },
        });

        if (!tenantUser) {
            throw new UnauthorizedException('您不属于该租户，无法切换。');
        }

        return this.generateJwtToken(userId, tenantId, tenantUser.role, tenantUser.user.role);
    }

    async getProfile(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                phone: true,
                name: true, // [修改] 查询姓名
                avatarUrl: true, // [核心新增] 查询头像
                role: true,
                status: true,
                createdAt: true,
                tenants: {
                    where: { status: 'ACTIVE' },
                    select: {
                        tenant: { select: { id: true, name: true } },
                        role: true,
                    },
                },
            },
        });

        if (!user) {
            throw new NotFoundException('用户不存在');
        }

        return user;
    }
}
