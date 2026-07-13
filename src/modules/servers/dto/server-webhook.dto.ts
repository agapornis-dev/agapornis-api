export class CreateServerWebhookDto {
  name?: string;
  provider?: string;
  url?: string;
  secret?: string;
  enabled?: boolean;
  events?: string[];
  headers?: Record<string, string>;
}
