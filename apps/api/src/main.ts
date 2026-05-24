import type { Health } from '@rcab/shared';

// NestJS bootstrap will replace this in E1.S7/S8.
// Importing Health here proves the cross-workspace link is wired.
const status: Health = { ok: true };

export { status };
