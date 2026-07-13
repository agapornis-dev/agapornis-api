import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

export type DomainErrorCode =
  | 'bad_request'
  | 'conflict'
  | 'forbidden'
  | 'not_found'
  | 'service_unavailable';

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: DomainErrorCode = 'bad_request',
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class TooManyRequestsError extends HttpException {
  constructor(message = 'too many attempts, please try again later') {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export function toNestException(error: unknown) {
  if (error instanceof DomainError) {
    if (error.code === 'conflict') return new ConflictException(error.message);
    if (error.code === 'forbidden') return new ForbiddenException(error.message);
    if (error.code === 'not_found') return new NotFoundException(error.message);
    if (error.code === 'service_unavailable') return new ServiceUnavailableException(error.message);
    return new BadRequestException(error.message);
  }

  const message = error instanceof Error ? error.message : 'request failed';
  if (message === 'user not found' || message === 'node not found') return new NotFoundException(message);
  if (/last owner|cannot delete your own account|transfer or delete/i.test(message)) return new ConflictException(message);
  if (/only an owner|requires owner|cannot manage/i.test(message)) return new ForbiddenException(message);
  return new BadRequestException(message);
}
