import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreatePaymentOrderDto {
    @IsUUID()
    planId!: string;
}

export class CreateRefundDto {
    @IsInt()
    @Min(1)
    amountInCents!: number;

    @IsString()
    @IsOptional()
    reason?: string;
}
