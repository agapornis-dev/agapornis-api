import { ConsoleLogger } from '@nestjs/common';
import { ApiErrorLogStore } from './api-error-log.store';

export class PanelLogger extends ConsoleLogger {
  constructor(private readonly errorLogs = new ApiErrorLogStore()) {
    super();
  }

  override error(message: any, ...optionalParams: any[]): void {
    super.error(message, ...optionalParams);

    const context = this.contextFrom(optionalParams);
    const stack = optionalParams.find(value => typeof value === 'string' && this.looksLikeStack(value));
    this.errorLogs.append({
      timestamp: new Date().toISOString(),
      level: 'error',
      context,
      message: this.format(message),
      stack,
    });
  }

  private contextFrom(values: any[]) {
    const strings = values.filter(value => typeof value === 'string');
    const candidate = strings[strings.length - 1];
    return candidate && !this.looksLikeStack(candidate) ? candidate : undefined;
  }

  private looksLikeStack(value: string) {
    return /(?:^|\n)\s*at\s+\S|\w*Error:\s/.test(value);
  }

  private format(value: any): string {
    if (value instanceof Error) return value.message || value.name;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}
