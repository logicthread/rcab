import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  requestId: string;
  startTime: bigint;
}

export const requestStore = new AsyncLocalStorage<RequestContext>();

export function getRequestId(): string | undefined {
  return requestStore.getStore()?.requestId;
}
