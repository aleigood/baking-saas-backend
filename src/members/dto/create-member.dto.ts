import { IsNotEmpty, IsString, IsEnum } from 'class-validator';
import { TenantRole } from '@prisma/client';
import { Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateMemberDto {
    @IsString()
    @IsNotEmpty()
    @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
    @Matches(/^1\d{10}$/, { message: '请输入正确的11位手机号' })
    phone!: string;

    @IsEnum(TenantRole)
    @IsNotEmpty()
    role!: TenantRole;
}
