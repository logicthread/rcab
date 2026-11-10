import { HttpException, HttpStatus } from '@nestjs/common';

export class OsrmUnavailableException extends HttpException {
  constructor() {
    super(
      { code: 'routing_unavailable', message: 'Routing service is temporarily unavailable' },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
