/**
 * Proves the dev loader (scripts/dev-register.cjs) emits decorator metadata so
 * Nest's implicit constructor injection works (F04).
 *
 * Run as:  node -r ./scripts/dev-register.cjs scripts/check-dev-loader.cjs
 * (the `test:dev-loader` package script does exactly that). Under `tsx` the same
 * script fails: RidesController's `design:paramtypes` is missing.
 */
const assert = require('node:assert/strict');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');

const { RidesController } = require('../src/modules/rides/rides.controller.ts');
const { PricingService } = require('../src/modules/pricing/pricing.service.ts');
const { AuthGuard } = require('../src/common/guards/auth.guard.ts');
const { REDIS } = require('../src/infra/redis/redis.module.ts');

async function main() {
  const paramTypes = Reflect.getMetadata('design:paramtypes', RidesController);
  assert.ok(
    Array.isArray(paramTypes),
    'no design:paramtypes on RidesController — the loader is not emitting decorator metadata',
  );
  assert.ok(paramTypes.includes(PricingService), 'PricingService missing from RidesController paramtypes');

  // Build a Nest app context where every constructor dependency (taken from the
  // emitted metadata, not from a hand-written list) is a marker stub.
  const providers = [];
  const stubs = new Map();
  paramTypes.forEach((type, index) => {
    const override = Reflect.getMetadata('self:paramtypes', RidesController)?.find((p) => p.index === index);
    const token = override ? override.param : type;
    if (stubs.has(token)) return;
    const stub = { marker: String(token?.name ?? token?.toString?.()) };
    stubs.set(token, stub);
    providers.push({ provide: token, useValue: stub });
  });
  assert.ok(stubs.has(REDIS), 'REDIS token should be injected explicitly');

  const moduleRef = await Test.createTestingModule({ controllers: [RidesController], providers })
    .overrideGuard(AuthGuard)
    .useValue({ canActivate: () => true })
    .compile();
  const controller = moduleRef.get(RidesController);
  assert.strictEqual(
    controller.pricing,
    stubs.get(PricingService),
    'RidesController.pricing was not injected with PricingService',
  );
  await moduleRef.close();
  console.log('check-dev-loader: RidesController received PricingService via the dev loader');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
