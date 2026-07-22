import { BadRequestException } from '@nestjs/common';

export type RequestObject = Record<string, unknown>;

export function requestObject(value: unknown): RequestObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('request body must be an object');
  }
  return value as RequestObject;
}

export function stringField(
  body: RequestObject,
  name: string,
  options: { required?: boolean; min?: number; max?: number; label?: string; trim?: boolean } = {},
) {
  const label = options.label || name;
  const raw = body[name];
  if (raw === undefined || raw === null) {
    if (options.required) throw new BadRequestException(`${label} is required`);
    return '';
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new BadRequestException(`${label} must be a string`);
  }
  const value = options.trim === false ? String(raw) : String(raw).trim();
  if (options.required && !value) throw new BadRequestException(`${label} is required`);
  if (options.min !== undefined && value.length < options.min) {
    throw new BadRequestException(`${label} must be at least ${options.min} characters`);
  }
  if (options.max !== undefined && value.length > options.max) {
    throw new BadRequestException(`${label} must be ${options.max} characters or fewer`);
  }
  return value;
}

export function emailField(body: RequestObject, name = 'email') {
  const email = stringField(body, name, { required: true, max: 255 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BadRequestException('email must be a valid email address');
  }
  return email;
}

export function optionalEmailField(body: RequestObject, name = 'email') {
  const email = stringField(body, name, { max: 255 }).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BadRequestException(`${name} must be a valid email address`);
  }
  return email;
}

export function numberField(
  body: RequestObject,
  name: string,
  options: { min: number; max: number; fallback: number; label?: string },
) {
  const label = options.label || name;
  const raw = body[name];
  if (raw === undefined || raw === null || raw === '') return options.fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new BadRequestException(`${label} must be a number`);
  return Math.min(options.max, Math.max(options.min, Math.round(value)));
}

export function oneTimeCodeField(body: RequestObject, name = 'code') {
  return stringField(body, name, { required: true, min: 4, max: 128, label: 'authentication code' });
}

export function urlField(body: RequestObject, name: string) {
  const value = stringField(body, name, { required: true, max: 2048 });
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid url');
    return url.toString();
  } catch {
    throw new BadRequestException(`${name} must be a valid HTTP URL`);
  }
}
