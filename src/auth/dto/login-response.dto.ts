/**
 * 文件路径: src/auth/dto/login-response.dto.ts
 * 文件描述: [新增] 定义登录成功后返回给客户端的数据结构。
 */
export class LoginResponseDto {
    accessToken: string;
    redirectTo?: string; // 可选的重定向路径
}
