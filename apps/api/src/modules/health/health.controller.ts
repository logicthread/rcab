import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { Response } from 'express';
import { register } from 'prom-client';
import { HealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(private health: HealthService) {}

  @Get('v1/health/live')
  live(): { ok: true } {
    return this.health.liveness();
  }

  @Get('v1/health/ready')
  @HttpCode(200)
  async ready(@Res() res: Response): Promise<void> {
    const result = await this.health.readiness();
    res.status(result.ok ? 200 : 503).json(result);
  }

  /** Root alias for readiness — used by pnpm dev:smoke and smoke scripts. */
  @Get('/')
  @HttpCode(200)
  async rootReady(@Res() res: Response): Promise<void> {
    const result = await this.health.readiness();
    res.status(result.ok ? 200 : 503).json(result);
  }

  @Get('metrics')
  async metrics(@Res() res: Response): Promise<void> {
    const body = await register.metrics();
    res.setHeader('content-type', register.contentType).status(200).send(body);
  }
}
