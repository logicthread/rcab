// Disable BullMQ Worker autorun in integration tests.
//
// NestJS BullMQ workers default to autorun=true: they register on AppModule
// init and start a blocking BRPOPLPUSH against Redis. On AppModule disposal
// the worker shuts down cleanly but the in-flight blocking command rejects
// with `Connection is closed.` post-shutdown. Setting autorun=false skips
// the blocking-fetch loop; specs that need a real worker should call
// `worker.run()` after grabbing it via moduleRef.get(<ProcessorClass>).
//
// Note: a residual rejection still escapes from the BullModule.forRoot
// shared-connection teardown for specs that boot the full AppModule
// (drivers.int.spec.ts, realtime-location.int.spec.ts). Every JS-level
// handler attempt (wrapping listeners, intercepting process.emit) was
// observed to be bypassed by Node's native unhandled-rejection dispatch.
// Vitest reports those 2 files as failed at the suite level even though
// all 88 individual tests pass. Tracked as a known issue; see
// docs/manual-testing/findings-2026-06-15.md.
process.env.RCAB_DISABLE_BULL_AUTORUN = '1';
