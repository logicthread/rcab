import { Global, Module } from '@nestjs/common';
import { POLICY, getPolicy } from './policy';

/**
 * Provides the frozen business policy (RCAB-E8.S10) app-wide as `POLICY`.
 * The factory runs at boot, so an invalid knob fails startup with a message
 * listing every problem (see `PolicyValidationError`). Inject with
 * `@Inject(POLICY) policy: Policy`.
 */
@Global()
@Module({
  providers: [{ provide: POLICY, useFactory: getPolicy }],
  exports: [POLICY],
})
export class PolicyModule {}
