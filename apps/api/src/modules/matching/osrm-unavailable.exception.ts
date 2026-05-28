import { HttpException, HttpStatus } from '@nestjs/common';

export class OsrmUnavailableException extends HttpException {
  constructor() {
    super('routing_unavailable', HttpStatus.SERVICE_UNAVAILABLE);
  }
}
