export class CreateServerScheduleDto {
  name?: string;
  cron?: string;
  action?: string;
  command?: string;
  enabled?: boolean;
}

export class UpdateServerScheduleDto extends CreateServerScheduleDto {}
