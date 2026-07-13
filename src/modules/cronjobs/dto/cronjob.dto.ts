export class CreateCronJobDto {
  name?: string;
  schedule?: string;
  command?: string;
  enabled?: boolean;
  payload?: Record<string, unknown>;
}
