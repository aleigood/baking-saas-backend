import { IsString, IsNotEmpty } from 'class-validator';

export class TenantDataDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}
