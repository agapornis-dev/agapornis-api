import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { DomainError, toNestException } from './domain-errors';

@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<any>();
    const nestException = toNestException(exception);
    const status = nestException.getStatus();
    response.status(status).send(nestException.getResponse());
  }
}
