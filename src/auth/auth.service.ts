// 文件路径: src/auth/auth.service.ts
import {
    Injectable,
    UnauthorizedException,
    ConflictException,
    NotFoundException,
    BadGatewayException,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthDto, RegisterDto, WechatLoginDto, LoginResponseDto } from './dto/auth.dto'; // [核心修正] 更新导入
import * as bcrypt from 'bcrypt';
import { GlobalRole, Prisma, TenantRole, TenantStatus, User, UserStatus } from '@prisma/client';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { SmsService } from '../sms/sms.service';
import { getUserDisplayName } from '../common/utils/user-display.util';
import { getAvatarIdFromPath, getRandomAvatarPath } from '../users/avatar-catalog';
import { createHash } from 'crypto';
// [核心删除] 不再需要单独导入 LoginResponseDto

@Injectable()
export class AuthService {
    constructor(
        private prisma: PrismaService,
        private jwtService: JwtService,
        private smsService: SmsService,
        private configService: ConfigService,
    ) {}

    sendRegistrationCode(phone: string, requestIp?: string) {
        return this.smsService.sendRegistrationCode(phone, requestIp);
    }

    sendProfileCode(phone: string, requestIp?: string) {
        return this.smsService.sendProfileCode(phone, requestIp);
    }

    private generateJwtToken(
        userId: string,
        tenantId: string,
        tenantRole: TenantRole,
        globalRole: GlobalRole,
    ): { accessToken: string } {
        const payload: JwtPayload = {
            sub: userId,
            tenantId,
            tenantRole,
            globalRole,
        };
        return {
            accessToken: this.jwtService.sign(payload),
        };
    }

    async register(registerDto: RegisterDto): Promise<LoginResponseDto> {
        const { phone, password, verificationCode } = registerDto;

        const existingUser = await this.prisma.user.findUnique({
            where: { phone },
        });
        if (existingUser) {
            throw new ConflictException('该手机号已被注册');
        }

        const challengeId = await this.smsService.verifyRegistrationCode(phone, verificationCode);
        const hashedPassword = await bcrypt.hash(password, 10);
        const verifiedAt = new Date();

        const user = await this.prisma.$transaction(async (tx) => {
            await this.smsService.consumeRegistrationCode(tx, challengeId);
            return tx.user.create({
                data: {
                    phone,
                    phoneVerifiedAt: verifiedAt,
                    password: hashedPassword,
                    avatarUrl: getRandomAvatarPath(),
                },
            });
        });
        return {
            ...this.generateJwtToken(user.id, '', TenantRole.MEMBER, user.globalRole),
            redirectTo: '/pages/onboarding/store-access',
        };
    }

    async login(loginDto: AuthDto): Promise<LoginResponseDto> {
        const user = await this.prisma.user.findUnique({
            where: { phone: loginDto.phone },
            include: {
                tenants: {
                    where: { status: UserStatus.ACTIVE, tenant: { status: TenantStatus.ACTIVE } },
                    // [核心修改] 在查询时直接带出店铺信息
                    include: {
                        tenant: true,
                    },
                    orderBy: { tenant: { createdAt: 'asc' } },
                },
            },
        });

        if (!user || !user.password || !(await bcrypt.compare(loginDto.password, user.password))) {
            throw new UnauthorizedException('手机号或密码错误');
        }

        if (user.globalRole === GlobalRole.SUPER_ADMIN) {
            const token = this.generateJwtToken(user.id, '', TenantRole.MEMBER, user.globalRole);
            return { accessToken: token.accessToken };
        }

        const firstTenantUser = user.tenants[0];
        if (!firstTenantUser) {
            return {
                ...this.generateJwtToken(user.id, '', TenantRole.MEMBER, user.globalRole),
                redirectTo: '/pages/onboarding/store-access',
            };
        }

        const token = this.generateJwtToken(user.id, firstTenantUser.tenantId, firstTenantUser.role, user.globalRole);

        // [核心修正] 如果用户在店铺中的角色是普通成员（即面包师），则添加重定向路径
        if (firstTenantUser.role === TenantRole.MEMBER) {
            return {
                accessToken: token.accessToken,
                redirectTo: '/pages/baker/main',
            };
        }

        return { accessToken: token.accessToken };
    }

    async loginByWechat(wechatLoginDto: WechatLoginDto): Promise<LoginResponseDto> {
        await this.cleanupAbandonedWechatUsers();
        const identity = await this.exchangeWechatCode(wechatLoginDto.code);
        let user = await this.findWechatUser(identity);

        if (!user) {
            try {
                user = await this.prisma.user.create({
                    data: {
                        phone: null,
                        password: null,
                        wechatOpenId: identity.openid,
                        wechatUnionId: identity.unionid,
                        avatarUrl: getRandomAvatarPath(),
                    },
                });
            } catch (error) {
                // 同一个微信 code 在并发请求中只允许创建一个账号，另一个请求复用已创建账号。
                if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
                user = await this.findWechatUser(identity);
                if (!user) throw error;
            }
        } else if (user.wechatOpenId !== identity.openid || user.wechatUnionId !== identity.unionid) {
            user = await this.prisma.user.update({
                where: { id: user.id },
                data: {
                    wechatOpenId: identity.openid,
                    ...(identity.unionid ? { wechatUnionId: identity.unionid } : {}),
                },
            });
        }

        if (user.status !== UserStatus.ACTIVE) throw new UnauthorizedException('账号已停用');
        return this.buildLoginResponse(user.id, user.globalRole);
    }

    async switchTenant(userId: string, tenantId: string): Promise<{ accessToken: string }> {
        const tenantUser = await this.prisma.tenantUser.findUnique({
            where: {
                userId_tenantId: { userId, tenantId },
            },
            // [核心修改] 同时查询关联的店铺信息和用户信息
            include: { user: true, tenant: true },
        });

        if (!tenantUser) {
            throw new UnauthorizedException('您不属于该租户，无法切换。');
        }

        if (tenantUser.status !== UserStatus.ACTIVE || tenantUser.user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException('您在该店铺的成员身份已停用，无法切换。');
        }

        // [核心新增] 切换店铺时检查目标店铺的状态
        if (tenantUser.tenant.status === TenantStatus.INACTIVE) {
            throw new UnauthorizedException('目标店铺已被停用，无法切换。');
        }

        return this.generateJwtToken(userId, tenantId, tenantUser.role, tenantUser.user.globalRole);
    }

    async getProfile(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                phone: true,
                phoneVerifiedAt: true,
                name: true, // [修改] 查询姓名
                wechatNickname: true,
                profileCompletedAt: true,
                avatarUrl: true, // [核心新增] 查询头像
                wechatOpenId: true,
                wechatUnionId: true,
                globalRole: true,
                status: true,
                createdAt: true,
                tenants: {
                    // [核心修改] 只返回状态为 ACTIVE 的店铺列表，避免用户看到已停用的
                    where: {
                        status: 'ACTIVE',
                        tenant: {
                            status: 'ACTIVE',
                        },
                    },
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

        const { wechatOpenId, wechatUnionId, ...profile } = user;

        return {
            ...profile,
            avatarId: getAvatarIdFromPath(profile.avatarUrl),
            displayName: profile.wechatNickname?.trim() || getUserDisplayName(profile),
            hasWechatBinding: Boolean(wechatOpenId || wechatUnionId),
        };
    }

    async refreshLoginResponse(userId: string): Promise<LoginResponseDto> {
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { globalRole: true } });
        if (!user) throw new NotFoundException('用户不存在');
        return this.buildLoginResponse(userId, user.globalRole);
    }

    async bindWechat(userId: string, code: string) {
        const result = await this.exchangeWechatCode(code);

        const occupied = await this.prisma.user.findFirst({
            where: {
                id: { not: userId },
                OR: [{ wechatOpenId: result.openid }, ...(result.unionid ? [{ wechatUnionId: result.unionid }] : [])],
            },
            select: { id: true },
        });
        if (occupied) throw new ConflictException('该微信账号已绑定其他用户');
        await this.prisma.user.update({
            where: { id: userId },
            data: { wechatOpenId: result.openid, wechatUnionId: result.unionid },
        });
        return { bound: true };
    }

    private async buildLoginResponse(userId: string, globalRole: GlobalRole): Promise<LoginResponseDto> {
        const membership = await this.prisma.tenantUser.findFirst({
            where: { userId, status: UserStatus.ACTIVE, tenant: { status: TenantStatus.ACTIVE } },
            include: { tenant: true },
            orderBy: { tenant: { createdAt: 'asc' } },
        });
        if (!membership) {
            return {
                ...this.generateJwtToken(userId, '', TenantRole.MEMBER, globalRole),
                redirectTo: '/pages/onboarding/store-access',
            };
        }

        return {
            ...this.generateJwtToken(userId, membership.tenantId, membership.role, globalRole),
            ...(membership.role === TenantRole.MEMBER ? { redirectTo: '/pages/baker/main' } : {}),
        };
    }

    private async findWechatUser(identity: { openid: string; unionid?: string }): Promise<User | null> {
        const users = await this.prisma.user.findMany({
            where: {
                OR: [
                    { wechatOpenId: identity.openid },
                    ...(identity.unionid ? [{ wechatUnionId: identity.unionid }] : []),
                ],
            },
            take: 2,
        });
        if (users.length > 1) {
            // openid 与 unionid 不允许指向两个本地账号，否则任取其一会造成账号串用。
            throw new ConflictException('微信身份关联异常，请联系管理员处理');
        }
        return users[0] ?? null;
    }

    private async cleanupAbandonedWechatUsers(): Promise<void> {
        await this.prisma.user.deleteMany({
            where: {
                globalRole: GlobalRole.USER,
                profileCompletedAt: null,
                createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
                tenants: { none: {} },
                storeApplications: { none: {} },
                membershipApplications: { none: {} },
                createdJoinLinks: { none: {} },
                paymentOrders: { none: {} },
            },
        });
    }

    private async exchangeWechatCode(code: string): Promise<{ openid: string; unionid?: string }> {
        const nodeEnv = this.configService.get<string>('NODE_ENV');
        const provider = this.configService.get<string>('WECHAT_AUTH_PROVIDER', 'wechat').toLowerCase();
        if (provider === 'mock') {
            if (nodeEnv === 'production') throw new ServiceUnavailableException('生产环境不能使用微信登录 Mock');
            const digest = createHash('sha256').update(code).digest('hex').slice(0, 24);
            return { openid: `mock_${digest}` };
        }

        const appId = this.configService.get<string>('WECHAT_APP_ID');
        const appSecret = this.configService.get<string>('WECHAT_APP_SECRET');
        if (!appId || !appSecret) throw new ServiceUnavailableException('微信小程序登录参数尚未配置');
        const params = new URLSearchParams({
            appid: appId,
            secret: appSecret,
            js_code: code,
            grant_type: 'authorization_code',
        });
        try {
            const response = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${params.toString()}`, {
                signal: AbortSignal.timeout(8000),
            });
            const result = (await response.json()) as { openid?: string; unionid?: string; errmsg?: string };
            if (!response.ok || !result.openid)
                throw new BadGatewayException(result.errmsg || '微信登录失败，请稍后重试');
            return { openid: result.openid, unionid: result.unionid };
        } catch (error) {
            if (error instanceof BadGatewayException) throw error;
            throw new BadGatewayException('微信登录服务暂时不可用，请稍后重试');
        }
    }
}
