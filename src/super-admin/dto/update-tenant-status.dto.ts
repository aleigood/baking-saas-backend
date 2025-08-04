/**
 * 文件路径: src/super-admin/dto/update-tenant-status.dto.ts
 * 文件描述: [新增] 定义更新店铺状态时所需的数据传输对象。
 */
import { IsEnum, IsNotEmpty } from 'class-validator';
import { TenantStatus } from '@prisma/client';

export class UpdateTenantStatusDto {
    @IsEnum(TenantStatus)
    @IsNotEmpty()
    status: TenantStatus;
}
