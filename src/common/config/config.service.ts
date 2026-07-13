import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiConfigService {
  get(name: string, fallback = '') {
    const value = process.env[name];
    return value === undefined ? fallback : value;
  }

  bool(name: string, fallback = false) {
    const value = process.env[name];
    if (value === undefined) return fallback;
    return value === 'true';
  }

  int(name: string, fallback: number) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? Math.round(value) : fallback;
  }

  positiveInt(name: string, fallback: number) {
    const value = this.int(name, fallback);
    return value > 0 ? value : fallback;
  }

  isProduction() {
    return this.get('NODE_ENV') === 'production';
  }

  all() {
    return { ...process.env };
  }
}
