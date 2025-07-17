/**
 * 文件路径: src/auth/dto/auth.dto.ts
 * 文件描述:
 * 这个文件定义了认证相关的数据传输对象（DTO）。
 * DTO用于规范化客户端与服务器之间传输的数据结构，
 * 并可以配合class-validator等库进行数据验证，确保数据的准确性。
 */
export class RegisterDto {
  /**
   * 老板/管理员通过邮箱注册时，客户端需要发送的数据结构。
   */
  email: string;
  password?: string;
  name: string;
  tenantName: string; // 注册时需要提供门店名称
}

export class LoginDto {
  /**
   * 用户通过邮箱密码登录时的数据结构。
   */
  email: string;
  password?: string;
}

export class WechatLoginDto {
  /**
   * 用户通过微信登录（包括首次邀请登录和后续一键登录）时的数据结构。
   */
  code: string; // 从 wx.login() 获取的临时code
  tenantId?: string; // 从邀请链接中获取，可选
}
