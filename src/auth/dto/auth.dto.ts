// DTO (Data Transfer Object) 用于定义网络请求的数据结构，并进行验证。
export class RegisterDto {
  email: string;
  password?: string;
  name: string;
  wechatOpenId?: string;
}

export class LoginDto {
  email: string;
  password?: string;
  wechatOpenId?: string;
}
