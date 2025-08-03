import { IsDateString, IsNotEmpty } from 'class-validator';

export class StatsDto {
  @IsDateString()
  @IsNotEmpty()
  startDate: string;

  @IsDateString()
  @IsNotEmpty()
  endDate: string;
}
