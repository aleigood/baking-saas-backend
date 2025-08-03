import { IsString, IsNotEmpty, IsUUID } from 'class-validator';

export class CreateTenantDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    // --- 新增字段 ---
    @IsUUID()
    @IsNotEmpty()
    ownerId: string;
}
