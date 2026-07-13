export class CreateWebhookTargetDto {
  name?: string;
  provider?: string;
  url?: string;
  chatId?: string;
  secret?: string;
  enabled?: boolean;
  events?: string[];
  headers?: Record<string, string>;
}

export class WebhookTestPayloadDto {
  ok?: boolean;
  event?: string;
}

export class IncomingWebhookPayloadDto {
  event?: string;
  data?: unknown;
  payload?: unknown;
}
