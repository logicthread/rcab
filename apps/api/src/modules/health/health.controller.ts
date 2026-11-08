import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { register } from 'prom-client';
import { HealthService } from './health.service';

@Controller()
export class HealthController {
  constructor(@Inject(HealthService) private health: HealthService) {}

  @Get('v1/health/live')
  live(): { ok: true } {
    return this.health.liveness();
  }

  /**
   * Running build identity (RCAB-E8.S11). Injected at image build time via the
   * RCAB_VERSION / RCAB_BUILT_AT build args (Dockerfile.prod); the release
   * pipeline asserts `version` equals the commit it just deployed.
   */
  @Get('v1/health/version')
  version(): { version: string; builtAt: string } {
    return {
      version: process.env.RCAB_VERSION || 'dev',
      builtAt: process.env.RCAB_BUILT_AT || 'unknown',
    };
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
