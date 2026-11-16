// context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SelfHostedInstance } from '@gitroom/nestjs-libraries/chat/mcp.relay.service';

type Ctx = {
  requestId: string;
  auth: any; // replace with your org type if you have it, e.g. Organization
  // a self-hosted connection: where its tool calls are relayed to
  relay?: SelfHostedInstance & { id: string };
  // where the call came from: the approval gate (human.approval.ts) is skipped
  // only for 'app' (the in-app chat), so an entry point that forgets it is gated
  surface?: 'mcp' | 'app';
  // an OAuth connection's granted scope ("mcp:read" = read-only); undefined
  // for API keys and the in-app chat, which may do everything
  scope?: string;
};

const als = new AsyncLocalStorage<Ctx>();

export function runWithContext<T>(ctx: Ctx, fn: () => Promise<T> | T) {
  return als.run(ctx, fn);
}

export function getContext(): Ctx | undefined {
  return als.getStore();
}

export function getAuth<T = any>(): T | undefined {
  return als.getStore()?.auth as T | undefined;
}

export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}

export function getRelay(): Ctx['relay'] {
  return als.getStore()?.relay;
}