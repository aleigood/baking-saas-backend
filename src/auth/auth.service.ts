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
import { Role, SystemRole } from '@prisma/client';
import { InvitationsService } from '../invitations/invitations.service';

/**
 * 模拟的微信服务
 * @description 在真实项目中，这里会使用http客户端（如Axios）请求微信服务器的API。
 * 为了方便测试，我们在此模拟这个过程。
 */
const mockWechatService = {
  /**
   * --- 修复点 1: 解决 'require-await' 警告 ---
   * 移除了不必要的 async 关键字，并显式返回一个Promise，
   * 这样既能满足异步的接口定义，也符合ESLint的规范。
   */
  getOpenId: (code: string): Promise<string> => {
    console.log(`正在用code: ${code} 换取 openId...`);
    // 基于code生成一个假的、但唯一的openid用于模拟
    return Promise.resolve(`mock_openid_for_${code}`);
  },
};

@Injectable()
export class AuthService {
  /**
   * 构造函数，通过依赖注入的方式，引入了PrismaService和JwtService的实例。
   * @param prisma - 用于数据库操作的服务
   * @param jwtService - 用于生成和验证JWT令牌的服务
   */
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private invitationsService: InvitationsService,
  ) {}

  /**
   * 场景A：老板通过邮箱注册
   * @param registerDto - 包含注册信息的DTO
   * @returns 返回一个包含access_token的对象
   */
  async register(registerDto: RegisterDto) {
    const { email, password, name, tenantName } = registerDto;

    // 检查邮箱是否已被注册
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) throw new ConflictException('该邮箱已被注册');
    if (!password) throw new BadRequestException('密码不能为空');
    // 使用bcrypt对密码进行哈希加密，增加安全性
    const hashedPassword = await bcrypt.hash(password, 10);
    // 使用Prisma的事务功能，确保用户、门店和关联关系三者要么全部创建成功，要么全部失败回滚。
    return this.prisma.$transaction(async (tx) => {
      // 1. 创建用户
      const user = await tx.user.create({
        data: { email, name, passwordHash: hashedPassword },
      });
      // 2. 创建门店
      const tenant = await tx.tenant.create({ data: { name: tenantName } });
      // 3. 在TenantUser中间表中，将用户与门店关联，并设定其角色为OWNER（老板）
      await tx.tenantUser.create({
        data: { tenantId: tenant.id, userId: user.id, role: Role.OWNER },
      });
      // 4. 为新注册的老板签发一个JWT令牌，使其能立刻登录系统
      return this.generateJwtToken(user.id, tenant.id, Role.OWNER);
    });
  }

  /**
   * 场景D的子流程：邮箱密码登录
   * @param loginDto - 包含登录信息的DTO
   * @returns 返回一个包含access_token的对象
   */
  async login(loginDto: LoginDto) {
    // 根据邮箱查找用户，并同时带上他所有关联的门店信息
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
      include: { tenants: true },
    });
    // 如果用户不存在，或密码不匹配，则抛出未授权异常
    if (!user || !user.passwordHash || !loginDto.password)
      throw new UnauthorizedException('邮箱或密码错误');
    const isPasswordMatching = await bcrypt.compare(
      loginDto.password,
      user.passwordHash,
    );
    if (!isPasswordMatching) throw new UnauthorizedException('邮箱或密码错误');

    // [修改] 增加超级管理员登录逻辑
    if (user.systemRole === SystemRole.SUPER_ADMIN) {
      // 超级管理员不属于任何店铺，tenantId可以为空字符串或特定标识
      // [类型修正] 为 role 参数传递一个有效的 Role 枚举值，因为超级管理员的权限由 systemRole 控制，此处的 role 仅为占位。
      return this.generateJwtToken(user.id, '', Role.BAKER, user.systemRole);
    }

    // 默认登录到用户的第一个门店
    const firstTenantUser = user.tenants[0];
    if (!firstTenantUser)
      throw new UnauthorizedException('该用户未加入任何门店');
    // 签发JWT令牌
    return this.generateJwtToken(
      user.id,
      firstTenantUser.tenantId,
      firstTenantUser.role,
      user.systemRole || undefined, // [类型修正] 确保 null 值被转换为 undefined
    );
  }

  /**
   * 场景C和D的核心：处理所有微信登录
   * @param wechatLoginDto - 包含微信code和可选的tenantId的DTO
   * @returns 返回一个包含access_token的对象
   */
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

    // 1. 用code换取用户的唯一标识OpenID
    const openId = await mockWechatService.getOpenId(code);

    // 2. 尝试根据OpenID在数据库中查找用户
    let user = await this.prisma.user.findUnique({
      where: { wechatOpenId: openId },
      include: { tenants: true },
    });

    // 3. 场景C-情况一：全新用户通过邀请进入 (数据库没这个用户，但有邀请链接里的门店ID)
    if (!user && tenantId) {
      // 使用事务来保证原子性
      const newUserInTx = await this.prisma.$transaction(async (tx) => {
        // 3a. 隐式创建新用户
        const newUser = await tx.user.create({
          data: { name: '微信用户', wechatOpenId: openId }, // 真实项目中可从微信获取昵称
        });
        // 3b. 将新用户加入到被邀请的门店，并赋予默认的BAKER角色
        await tx.tenantUser.create({
          data: { tenantId: tenantId, userId: newUser.id, role: Role.BAKER },
        });
        return newUser;
      });
      // 为了后续逻辑统一，手动组装一个完整的user对象
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
    return this.generateJwtToken(
      user.id,
      targetTenantId,
      tenantUserInfo.role,
      user.systemRole || undefined, // [类型修正] 确保 null 值被转换为 undefined
    );
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

  // [修改] 增加 systemRole 参数
  private generateJwtToken(
    userId: string,
    tenantId: string,
    role: Role,
    systemRole?: SystemRole,
  ) {
    const payload = {
      sub: userId,
      tenantId: tenantId,
      role: role,
      systemRole: systemRole,
    };
    return { access_token: this.jwtService.sign(payload) };
  }
}
