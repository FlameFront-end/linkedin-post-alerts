import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { LinkedInError } from './errors.js';
export const trafficScopes = ['feed', 'search', 'jobs'] as const;
export type TrafficScope = (typeof trafficScopes)[number];
export const protectionPolicySchema = z.object({
  minGapMs: z.number().int().min(15000).max(60000).default(20000),
  hourlyRequests: z.number().int().min(1).max(40).default(20),
  dailyRequests: z.number().int().min(1).max(500).default(150),
  searchHourlyRequests: z.number().int().min(1).max(6).default(4),
  searchDailyRequests: z.number().int().min(1).max(40).default(20),
});
export type ProtectionPolicy = z.infer<typeof protectionPolicySchema>;
const scopeSchema = z.object({
  successes: z.number().int().nonnegative().default(0),
  failures: z.number().int().nonnegative().default(0),
  until: z.number().nonnegative().default(0),
  hold: z.string().optional(),
  probe: z.enum(['armed', 'running']).optional(),
});
export const trafficStateSchema = z.object({
  version: z.literal(1).default(1),
  events: z
    .array(
      z.object({ at: z.number().nonnegative(), scope: z.enum(trafficScopes) }),
    )
    .max(1000)
    .default([]),
  nextAt: z.number().nonnegative().default(0),
  quietUntil: z.number().nonnegative().default(0),
  hold: z.string().optional(),
  lease: z
    .object({ id: z.string(), until: z.number().nonnegative() })
    .optional(),
  rateStrikes: z.number().int().nonnegative().default(0),
  lastRateAt: z.number().nonnegative().default(0),
  scopes: z
    .object({
      feed: scopeSchema.default(() => scopeSchema.parse({})),
      search: scopeSchema.default(() => scopeSchema.parse({})),
      jobs: scopeSchema.default(() => scopeSchema.parse({})),
    })
    .default(() => ({
      feed: scopeSchema.parse({}),
      search: scopeSchema.parse({}),
      jobs: scopeSchema.parse({}),
    })),
});
export type TrafficState = z.infer<typeof trafficStateSchema>;
export interface ProtectionStore {
  update<T>(operation: (state: TrafficState) => T): Promise<T>;
}
export interface ScopedProtection {
  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  failure(error: LinkedInError): Promise<void>;
  budget(requested: number): Promise<number>;
}
const hour = 3600000,
  day = 24 * hour;
export const minimumPollMs: Record<TrafficScope, number> = {
  feed: 600000,
  search: 1800000,
  jobs: 3600000,
};
export class TrafficProtection {
  private readonly accounted = new WeakSet<LinkedInError>();
  constructor(
    private readonly store: ProtectionStore,
    readonly policy: ProtectionPolicy = protectionPolicySchema.parse({}),
    private readonly now = Date.now,
    private readonly wait: (
      ms: number,
      signal?: AbortSignal,
    ) => Promise<void> = (ms, signal) =>
      sleep(ms, undefined, signal ? { signal } : undefined).then(
        () => undefined,
      ),
  ) {}
  forScope(scope: TrafficScope): ScopedProtection {
    return {
      run: (operation, signal) => this.run(scope, operation, signal),
      failure: (error) => this.failure(scope, error),
      budget: (requested) => this.cycleBudget(scope, requested),
    };
  }
  async snapshot() {
    return this.store.update((state) => structuredClone(state));
  }
  async cycleBudget(scope: TrafficScope, requested: number) {
    return this.store.update((state) => {
      const current = state.scopes[scope];
      if (current.probe) return 1;
      const maximum = { feed: 3, search: 2, jobs: 4 }[scope];
      const warmup =
        current.successes < 3
          ? scope === 'jobs'
            ? 2
            : 1
          : current.successes < 6
            ? 2
            : maximum;
      return Math.min(requested, maximum, warmup);
    });
  }
  async armProbe(scope: TrafficScope, confirmedAccount = false) {
    await this.store.update((state) => {
      if (state.hold && !confirmedAccount)
        throw new LinkedInError(
          'source_blocked',
          3600,
          'account_confirmation_required',
        );
      if (
        state.quietUntil > this.now() ||
        state.scopes[scope].until > this.now()
      )
        throw new LinkedInError(
          'protection_pause',
          Math.ceil(
            (Math.max(state.quietUntil, state.scopes[scope].until) -
              this.now()) /
              1000,
          ),
          'cooldown_not_expired',
        );
      if (confirmedAccount) delete state.hold;
      const current = state.scopes[scope];
      delete current.hold;
      current.probe = 'armed';
      current.successes = 0;
    });
  }
  async run<T>(
    scope: TrafficScope,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const id = randomUUID();
    while (true) {
      signal?.throwIfAborted();
      const reservation = await this.store.update((state) => {
        const now = this.now(),
          current = state.scopes[scope];
        state.events = state.events.filter((event) => event.at > now - day);
        if (state.hold)
          return {
            code: 'source_blocked' as const,
            seconds: 3600,
            reason: state.hold,
          };
        if (current.hold)
          return {
            code:
              current.hold === 'search_restricted'
                ? ('search_restricted' as const)
                : ('source_blocked' as const),
            seconds: 3600,
            reason: current.hold,
          };
        const until = Math.max(state.quietUntil, current.until);
        if (until > now)
          return {
            code: 'protection_pause' as const,
            seconds: Math.ceil((until - now) / 1000),
            reason: 'cooldown',
          };
        if (current.probe === 'running')
          return {
            code: 'source_blocked' as const,
            seconds: 3600,
            reason: 'probe_needs_confirmation',
          };
        let quotaUntil = 0;
        const quotas = [
          {
            events: state.events,
            limit: this.policy.dailyRequests,
            window: day,
          },
          {
            events: state.events,
            limit: this.policy.hourlyRequests,
            window: hour,
          },
        ];
        if (scope === 'search')
          quotas.push(
            {
              events: state.events.filter((event) => event.scope === 'search'),
              limit: this.policy.searchDailyRequests,
              window: day,
            },
            {
              events: state.events.filter((event) => event.scope === 'search'),
              limit: this.policy.searchHourlyRequests,
              window: hour,
            },
          );
        for (const quota of quotas) {
          const events = quota.events.filter(
            (event) => event.at > now - quota.window,
          );
          if (events.length >= quota.limit)
            quotaUntil = Math.max(
              quotaUntil,
              events[events.length - quota.limit]!.at + quota.window,
            );
        }
        if (quotaUntil > now)
          return {
            code: 'request_limit' as const,
            seconds: Math.ceil((quotaUntil - now) / 1000),
            reason: 'rolling_quota',
          };
        const available = Math.max(state.nextAt, state.lease?.until ?? 0);
        if (available > now) return { wait: Math.min(available - now, 60000) };
        state.events.push({ at: now, scope });
        state.nextAt = now + this.policy.minGapMs;
        state.lease = { id, until: now + 60000 };
        if (current.probe === 'armed') current.probe = 'running';
        return { granted: true };
      });
      if ('code' in reservation)
        throw new LinkedInError(
          reservation.code,
          Math.max(1, reservation.seconds!),
          reservation.reason,
        );
      if ('wait' in reservation) {
        await this.wait(reservation.wait!, signal);
        continue;
      }
      break;
    }
    try {
      const result = await operation();
      await this.store.update((state) => {
        const current = state.scopes[scope];
        current.successes = Math.min(100, current.successes + 1);
        current.failures = 0;
        if (current.probe === 'running') {
          delete current.probe;
          current.until = this.now() + minimumPollMs[scope];
        }
      });
      return result;
    } catch (error) {
      if (!signal?.aborted)
        await this.failure(
          scope,
          error instanceof LinkedInError ? error : new LinkedInError('network'),
        );
      throw error;
    } finally {
      await this.store.update((state) => {
        if (state.lease?.id === id) delete state.lease;
      });
    }
  }
  async failure(scope: TrafficScope, error: LinkedInError) {
    if (this.accounted.has(error)) return;
    this.accounted.add(error);
    if (
      [
        'budget',
        'request_limit',
        'protection_pause',
        'cooldown',
        'source_blocked',
        'item_unavailable',
      ].includes(error.code)
    )
      return;
    await this.store.update((state) => {
      const now = this.now(),
        current = state.scopes[scope];
      current.failures++;
      current.successes = 0;
      delete current.probe;
      if (error.code === 'search_restricted') {
        state.scopes.search.hold = 'search_restricted';
        state.scopes.search.successes = 0;
        state.quietUntil = Math.max(state.quietUntil, now + hour);
      } else if (error.code === 'auth_required') {
        state.hold = error.reason ?? 'auth_required';
      } else if (error.code === 'rate_limited') {
        if (scope === 'jobs') current.hold = 'jobs_rate_limited';
        if (error.reason === 'retry_after_exceeds_week')
          state.hold = 'retry_after_exceeds_week';
        if (now - state.lastRateAt > day) state.rateStrikes = 0;
        state.rateStrikes++;
        state.lastRateAt = now;
        state.quietUntil = Math.max(
          state.quietUntil,
          now +
            Math.max(
              error.retryAfterSeconds * 1000,
              Math.min(day, hour * 2 ** Math.min(state.rateStrikes - 1, 5)),
            ),
        );
      } else if (
        error.code === 'response_format' ||
        error.code === 'response_too_large' ||
        error.code === 'configuration'
      )
        current.hold = error.code;
      else
        current.until = Math.max(
          current.until,
          now +
            Math.min(6 * hour, 300000 * 2 ** Math.min(current.failures - 1, 7)),
        );
    });
  }
}
