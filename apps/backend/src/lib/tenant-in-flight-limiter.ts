import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Limits the requests of one tenant that run at the same time in this
 * process. A request over the limit waits in its tenant's queue, in arrival
 * order, for at most `maxWaitMs`. A full queue, a wait that times out, or a
 * caller that goes away gets `null`.
 *
 * Each tenant has its own count, so one tenant cannot use the slots of
 * another. A tenant's entry is removed when it has no running and no waiting
 * request, so the map holds only tenants with work in progress.
 */
export type InFlightRelease = () => void;

type Waiter = { grant: (release: InFlightRelease) => void };

type TenantSlots = { active: number; waiters: Waiter[] };

export type TenantInFlightLimiterOptions = {
  maxActivePerTenant: number;
  maxWaitingPerTenant: number;
  maxWaitMs: number;
};

export class TenantInFlightLimiter {
  private readonly tenants = new Map<string, TenantSlots>();

  constructor(private readonly options: TenantInFlightLimiterOptions) {}

  /** Resolves with a release function that the caller must call once, or with `null`. */
  acquire(tenantId: string, signal?: AbortSignal): Promise<InFlightRelease | null> {
    if (signal?.aborted) return Promise.resolve(null);
    let slots = this.tenants.get(tenantId);
    if (!slots) {
      slots = { active: 0, waiters: [] };
      this.tenants.set(tenantId, slots);
    }
    if (slots.active < this.options.maxActivePerTenant) {
      slots.active += 1;
      return Promise.resolve(this.releaseFor(tenantId, slots));
    }
    if (slots.waiters.length >= this.options.maxWaitingPerTenant) return Promise.resolve(null);
    const tenantSlots = slots;
    return new Promise<InFlightRelease | null>((resolve) => {
      const leave = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = tenantSlots.waiters.indexOf(waiter);
        if (index >= 0) tenantSlots.waiters.splice(index, 1);
        this.forgetIfIdle(tenantId, tenantSlots);
      };
      const waiter: Waiter = {
        grant: (release) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        }
      };
      const onAbort = () => {
        leave();
        resolve(null);
      };
      const timer = setTimeout(() => {
        leave();
        resolve(null);
      }, this.options.maxWaitMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      tenantSlots.waiters.push(waiter);
    });
  }

  /** Tenants with running or waiting requests. For tests and diagnostics. */
  trackedTenantCount(): number {
    return this.tenants.size;
  }

  /** Requests of the tenant that wait for a slot. For tests and diagnostics. */
  waitingCount(tenantId: string): number {
    return this.tenants.get(tenantId)?.waiters.length ?? 0;
  }

  private releaseFor(tenantId: string, slots: TenantSlots): InFlightRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = slots.waiters.shift();
      // The slot passes to the next waiter of the same tenant: `active` stays.
      if (next) {
        next.grant(this.releaseFor(tenantId, slots));
        return;
      }
      slots.active -= 1;
      this.forgetIfIdle(tenantId, slots);
    };
  }

  private forgetIfIdle(tenantId: string, slots: TenantSlots): void {
    if (slots.active === 0 && slots.waiters.length === 0 && this.tenants.get(tenantId) === slots) {
      this.tenants.delete(tenantId);
    }
  }
}

/** The part of a Fastify app that `registerTenantInFlightLimit` uses. */
type HookedApp = Pick<FastifyInstance, "addHook">;

/**
 * Applies `limiter` to the requests that `matches` selects, after the
 * authentication hooks (register it after them). The slot is taken before
 * the route runs and given back when the route has its reply (`onSend`), on
 * success and on error.
 *
 * A client that disconnects while it waits leaves the queue. A client that
 * disconnects while its route runs keeps the slot until the route ends, so
 * a client cannot start more work by closing connections. If the route does
 * not reach `onSend` (a hijacked reply), the slot is given back
 * `abandonedGraceMs` after the disconnect.
 */
export function registerTenantInFlightLimit(
  app: HookedApp,
  input: {
    limiter: TenantInFlightLimiter;
    matches: (request: FastifyRequest) => boolean;
    abandonedGraceMs: number;
    /** Reply for a request that gets no slot. */
    busy: (reply: FastifyReply) => FastifyReply;
  }
): void {
  const slots = new WeakMap<FastifyRequest, InFlightRelease>();
  app.addHook("onRequest", async (request, reply) => {
    if (!request.auth || !input.matches(request)) return;
    const disconnected = new AbortController();
    const onWaitClose = () => disconnected.abort();
    reply.raw.once("close", onWaitClose);
    const acquired = await input.limiter.acquire(request.auth.tenantId, disconnected.signal);
    reply.raw.removeListener("close", onWaitClose);
    if (!acquired) return input.busy(reply);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const release: InFlightRelease = () => {
      done = true;
      clearTimeout(timer);
      acquired();
    };
    slots.set(request, release);
    const onClose = () => {
      if (done) return;
      timer = setTimeout(release, input.abandonedGraceMs);
      timer.unref?.();
    };
    if (reply.raw.destroyed || disconnected.signal.aborted) onClose();
    else reply.raw.once("close", onClose);
  });
  app.addHook("onSend", async (request, _reply, payload) => {
    slots.get(request)?.();
    return payload;
  });
}
