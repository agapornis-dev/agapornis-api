import { Injectable } from '@nestjs/common';
import { ApiErrorLogStore } from '../../common/logging/api-error-log.store';

@Injectable()
export class PanelLogsService {
  private readonly store = new ApiErrorLogStore();

  listDays() {
    return { days: this.store.listDays() };
  }

  readDay(date: string) {
    const entries = this.store.readDay(date);
    return entries ? { date, entries } : undefined;
  }
}
