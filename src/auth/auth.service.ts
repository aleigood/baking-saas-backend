/**
 * 文件路径: src/auth/auth.service.ts
 * 文件描述: (已修正) 微信登录逻辑现在会验证邀请码，并修复了所有静态检查错误。
 */
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto, LoginDto, WechatLoginDto } from './dto/auth.dto';
import * as bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import { InvitationsService } from '../invitations/invitations.service';

const mockWechatService = {
  getOpenId: (code: string): Promise<string> => {
    console.log(`正在用code: ${code} 换取 openId...`);
    return Promise.resolve(`mock_openid_for_${code}`);
  },
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private invitationsService: InvitationsService,
  ) {}

  async register(registerDto: RegisterDto) {
    const { email, password, name, tenantName } = registerDto;
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) throw new ConflictException('该邮箱已被注册');
    if (!password) throw new BadRequestException('密码不能为空');
    const hashedPassword = await bcrypt.hash(password, 10);
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name, passwordHash: hashedPassword },
      });
      const tenant = await tx.tenant.create({ data: { name: tenantName } });
      await tx.tenantUser.create({
        data: { tenantId: tenant.id, userId: user.id, role: Role.OWNER },
      });
      return this.generateJwtToken(user.id, tenant.id, Role.OWNER);
    });
  }

  async login(loginDto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
      include: { tenants: true },
    });
    if (!user || !user.passwordHash || !loginDto.password)
      throw new UnauthorizedException('邮箱或密码错误');
    const isPasswordMatching = await bcrypt.compare(
      loginDto.password,
      user.passwordHash,
    );
    if (!isPasswordMatching) throw new UnauthorizedException('邮箱或密码错误');
    const firstTenantUser = user.tenants[0];
    if (!firstTenantUser)
      throw new UnauthorizedException('该用户未加入任何门店');
    return this.generateJwtToken(
      user.id,
      firstTenantUser.tenantId,
      firstTenantUser.role,
    );
  }

  async loginByWechat(wechatLoginDto: WechatLoginDto) {
    const { code, invitationCode } = wechatLoginDto;
    if (!code) throw new BadRequestException('微信登录凭证code不能为空');

    let tenantId: string | undefined;

    // [核心修复] 只有在提供了 invitationCode 时才进行验证
    if (invitationCode) {
      const invitation = await this.invitationsService.validate(invitationCode);
      // [核心修复] 增加对 invitation 是否存在的检查
      if (!invitation) {
        throw new BadRequestException('邀请码无效或已过期');
      }
      tenantId = invitation.tenantId;
    }

    const openId = await mockWechatService.getOpenId(code);
    let user = await this.prisma.user.findUnique({
      where: { wechatOpenId: openId },
      include: { tenants: true },
    });

    if (!user && tenantId) {
      const newUserInTx = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: { name: '微信用户', wechatOpenId: openId },
        });
        await tx.tenantUser.create({
          data: { tenantId: tenantId, userId: newUser.id, role: Role.BAKER },
        });
        return newUser;
      });
      user = {
        ...newUserInTx,
        tenants: [
          {
            tenantId,
            role: Role.BAKER,
            status: 'ACTIVE',
            createdAt: new Date(),
            userId: newUserInTx.id,
          },
        ],
      };
    }

    if (!user)
      throw new UnauthorizedException(
        '该微信未绑定任何账户，请通过邀请加入门店',
      );

    const isAlreadyInTenant = user.tenants.some((t) => t.tenantId === tenantId);
    if (tenantId && !isAlreadyInTenant) {
      await this.prisma.tenantUser.create({
        data: { tenantId, userId: user.id, role: Role.BAKER },
      });
    }

    const targetTenantId = tenantId || user.tenants[0]?.tenantId;
    if (!targetTenantId)
      throw new UnauthorizedException('该用户未加入任何门店');
    const tenantUserInfo = await this.prisma.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: targetTenantId, userId: user.id } },
    });
    if (!tenantUserInfo)
      throw new UnauthorizedException('无法找到用户在该门店的角色信息');
    return this.generateJwtToken(user.id, targetTenantId, tenantUserInfo.role);
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new UnauthorizedException();
    }
    // [核心修复] 解决 no-unused-vars 警告
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...result } = user;
    return result;
  }

  private generateJwtToken(userId: string, tenantId: string, role: Role) {
    const payload = { sub: userId, tenantId: tenantId, role: role };
    return { access_token: this.jwtService.sign(payload) };
  }
}
