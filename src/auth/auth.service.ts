import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto, LoginDto } from './dto/auth.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async register(registerDto: RegisterDto) {
    // 检查邮箱是否已被注册
    const existingUser = await this.prisma.user.findUnique({
      where: { email: registerDto.email },
    });

    if (existingUser) {
      throw new ConflictException('该邮箱已被注册');
    }

    // --- 修复点 1: 增加密码存在性检查 ---
    if (!registerDto.password) {
      throw new BadRequestException('密码不能为空');
    }

    // 对密码进行哈希加密
    const hashedPassword = await bcrypt.hash(registerDto.password, 10);

    // 创建新用户
    const user = await this.prisma.user.create({
      data: {
        email: registerDto.email,
        name: registerDto.name,
        passwordHash: hashedPassword,
      },
    });

    // --- 修复点 1: 解决 'passwordHash' 未使用的警告 ---
    // 我们的目的是从返回结果中排除 passwordHash，这种用法是正确的。
    // 我们通过下一行注释告诉ESLint忽略这个警告。
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...result } = user;
    return result;
  }

  async login(loginDto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
    });

    // --- 修复点 2: 增加用户和密码存在性检查 ---
    if (!user || !user.passwordHash || !loginDto.password) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 比较密码
    const isPasswordMatching = await bcrypt.compare(
      loginDto.password,
      user.passwordHash,
    );

    if (!isPasswordMatching) {
      throw new UnauthorizedException('邮箱或密码错误');
    }

    // 生成JWT令牌
    // 注意：在真实项目中，payload应该包含tenantId和role等信息
    const payload = { sub: user.id, email: user.email };

    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
