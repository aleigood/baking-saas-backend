import { IsNotEmpty, IsString } from 'class-validator';

// 修复：适配新的 User 模型，使用 phone
export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}
