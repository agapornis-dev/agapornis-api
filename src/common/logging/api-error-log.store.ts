import * as fs from 'fs';
import * as path from 'path';

export interface ApiErrorLogEntry {
  timestamp: string;
  level: 'error';
  context?: string;
  message: string;
  stack?: string;
}

export interface ApiErrorLogDay {
  date: string;
  entries: number;
  sizeBytes: number;
}

const FILE_PATTERN = /^api-error-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_ENTRY_LENGTH = 64 * 1024;

export class ApiErrorLogStore {
  readonly directory: string;

  constructor(directory = process.env.AGAPORNIS_API_LOG_DIR || path.join(process.cwd(), 'data', 'api-logs')) {
    this.directory = path.resolve(directory);
  }

  append(entry: ApiErrorLogEntry): void {
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const date = entry.timestamp.slice(0, 10);
      if (!this.validDate(date)) return;
      const line = JSON.stringify({
        ...entry,
        message: this.truncate(entry.message),
        stack: entry.stack ? this.truncate(entry.stack) : undefined,
      });
      fs.appendFileSync(this.fileForDate(date), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Logging must never take down the API or recursively log its own failure.
    }
  }

  listDays(): ApiErrorLogDay[] {
    try {
      if (!fs.existsSync(this.directory)) return [];
      return fs.readdirSync(this.directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && FILE_PATTERN.test(entry.name))
        .map(entry => {
          const match = entry.name.match(FILE_PATTERN)!;
          const file = path.join(this.directory, entry.name);
          return {
            date: match[1],
            entries: this.countLines(file),
            sizeBytes: fs.statSync(file).size,
          };
        })
        .sort((left, right) => right.date.localeCompare(left.date));
    } catch {
      return [];
    }
  }

  readDay(date: string): ApiErrorLogEntry[] | undefined {
    if (!this.validDate(date)) return undefined;
    const file = this.fileForDate(date);
    if (!fs.existsSync(file)) return undefined;

    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap(line => {
        try {
          const entry = JSON.parse(line);
          if (entry?.level !== 'error' || typeof entry?.message !== 'string') return [];
          return [{
            timestamp: String(entry.timestamp || ''),
            level: 'error' as const,
            context: entry.context ? String(entry.context) : undefined,
            message: entry.message,
            stack: entry.stack ? String(entry.stack) : undefined,
          }];
        } catch {
          return [];
        }
      })
      .reverse();
  }

  private fileForDate(date: string) {
    return path.join(this.directory, `api-error-${date}.jsonl`);
  }

  private validDate(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  }

  private countLines(file: string) {
    const content = fs.readFileSync(file, 'utf8');
    return content ? content.split(/\r?\n/).filter(Boolean).length : 0;
  }

  private truncate(value: string) {
    return value.length > MAX_ENTRY_LENGTH ? `${value.slice(0, MAX_ENTRY_LENGTH)}\n[truncated]` : value;
  }
}
