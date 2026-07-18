export class CreateServerScheduleDto {
  name?: string;
  intervalSeconds?: number;
  interval_seconds?: number;
  action?: string;
  command?: string;
  targetPath?: string;
  target_path?: string;
  path?: string;
  storage?: 'local' | 's3';
  enabled?: boolean;
}

export class UpdateServerScheduleDto extends CreateServerScheduleDto {}
