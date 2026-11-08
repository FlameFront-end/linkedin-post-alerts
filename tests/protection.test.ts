import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TrafficProtection,
  trafficStateSchema,
  protectionPolicySchema,
  type TrafficState,
  type ProtectionStore,
} from '../services/collector/src/linkedin/protection.js';
import { LinkedInClient } from '../services/collector/src/linkedin/client.js';
import { LinkedInError } from '../services/collector/src/linkedin/errors.js';
class MemoryStore implements ProtectionStore {
  state: TrafficState = trafficStateSchema.parse({});
  private tail = Promise.resolve();
  async update<T>(operation: (state: TrafficState) => T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const state = structuredClone(this.state);
      const result = operation(state);
      this.state = state;
      return result;
    } finally {
      release();
    }
  }
}
function harness(options: Record<string, number> = {}) {
  const store = new MemoryStore();
  let now = Date.UTC(2026, 10, 8);
  const clock = () => now;
  const wait = async (ms: number) => {
    now += ms;
  };
  const policy = protectionPolicySchema.parse(options);
  const guard = new TrafficProtection(store, policy, clock, wait);
  return {
    store,
    guard,
    clock,
    wait,
    policy,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const rejectsCode = (code: string) => (e: unknown) =>
  e instanceof LinkedInError && e.code === code;
const session = { liAt: 'SECRET', jsessionId: 'SECRET' };

test('Confirmed search suspension survives restarts and never tries another query', async () => {
  const h = harness();
  let calls = 0;
  const client = new LinkedInClient(
    session,
    0,
    async () => {
      calls++;
      return new Response(
        '<html><body>Наши системы обнаружили необычный поисковый трафик. Поисковые действия в вашей уч. записи были приостановлены. Повторите попытку позже.</body></html>',
        { headers: { 'content-type': 'text/html' } },
      );
    },
    undefined,
    h.guard.forScope('search'),
  );
  await assert.rejects(
    client.get('/search/results/content/?keywords=frontend'),
    rejectsCode('search_restricted'),
  );
  const restarted = new TrafficProtection(h.store, h.policy, h.clock, h.wait);
  await assert.rejects(
    restarted.run('search', async () => {
      calls++;
    }),
    rejectsCode('search_restricted'),
  );
  h.advance(48 * 3600000);
  await assert.rejects(
    restarted.run('search', async () => {
      calls++;
    }),
    rejectsCode('search_restricted'),
  );
  assert.equal(calls, 1);
});
test('Search restriction is recognized even when a JSON endpoint returns HTML', async () => {
  const h = harness();
  const client = new LinkedInClient(
    session,
    0,
    async () =>
      new Response(
        '<html><body>Your search activities have been suspended due to unusual search traffic.</body></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
    undefined,
    h.guard.forScope('search'),
  );
  await assert.rejects(
    client.get('/voyager/api/graphql?queryId=test'),
    rejectsCode('search_restricted'),
  );
  assert.equal(
    (await h.guard.snapshot()).scopes.search.hold,
    'search_restricted',
  );
});
test('All sources share an hourly ceiling, including Jobs, across processes', async () => {
  const h = harness({ hourlyRequests: 2 });
  let calls = 0;
  await h.guard.run('feed', async () => {
    calls++;
  });
  const other = new TrafficProtection(h.store, h.policy, h.clock, h.wait);
  await other.run('jobs', async () => {
    calls++;
  });
  await assert.rejects(
    other.run('search', async () => {
      calls++;
    }),
    rejectsCode('request_limit'),
  );
  assert.equal(calls, 2);
  assert.equal((await h.guard.snapshot()).events.length, 2);
});
test('Daily budget cannot be reset by restart or passing the hourly window', async () => {
  const h = harness({ hourlyRequests: 20, dailyRequests: 2 });
  await h.guard.run('feed', async () => {});
  await h.guard.run('jobs', async () => {});
  h.advance(3600001);
  const other = new TrafficProtection(h.store, h.policy, h.clock, h.wait);
  await assert.rejects(
    other.run('feed', async () => assert.fail('daily quota bypassed')),
    rejectsCode('request_limit'),
  );
});
test('Search has a smaller quota without stopping an otherwise healthy feed', async () => {
  const h = harness({ searchHourlyRequests: 1 });
  await h.guard.run('search', async () => {});
  await assert.rejects(
    h.guard.run('search', async () => assert.fail()),
    rejectsCode('request_limit'),
  );
  await h.guard.run('feed', async () => {});
});
test('429 pauses every source for at least one hour and honors a longer Retry-After', async () => {
  const h = harness();
  await assert.rejects(
    h.guard.run('jobs', async () => {
      throw new LinkedInError('rate_limited', 7200);
    }),
    rejectsCode('rate_limited'),
  );
  const state = await h.guard.snapshot();
  assert.equal(state.quietUntil - h.clock(), 7200000);
  await assert.rejects(
    h.guard.run('feed', async () => assert.fail()),
    rejectsCode('protection_pause'),
  );
});
test('Repeated 429 increases cooldown rather than resuming the old frequency', async () => {
  const h = harness();
  for (const expected of [3600000, 7200000]) {
    await assert.rejects(
      h.guard.run('search', async () => {
        throw new LinkedInError('rate_limited', 60);
      }),
      rejectsCode('rate_limited'),
    );
    const state = await h.guard.snapshot();
    assert.equal(state.quietUntil - h.clock(), expected);
    h.advance(expected + 1);
  }
});
test('Network errors back off and never issue another request during cooldown', async () => {
  const h = harness();
  let calls = 0;
  for (const delay of [300000, 600000, 1200000]) {
    await assert.rejects(
      h.guard.run('feed', async () => {
        calls++;
        throw new LinkedInError('network');
      }),
      rejectsCode('network'),
    );
    assert.equal(
      (await h.guard.snapshot()).scopes.feed.until - h.clock(),
      delay,
    );
    await assert.rejects(
      h.guard.run('feed', async () => {
        calls++;
      }),
      rejectsCode('protection_pause'),
    );
    h.advance(delay + 1);
  }
  assert.equal(calls, 3);
});
test('Parser drift freezes that source instead of trying every keyword', async () => {
  const h = harness();
  await h.guard.failure('search', new LinkedInError('response_format'));
  await assert.rejects(
    h.guard.run('search', async () => assert.fail()),
    rejectsCode('source_blocked'),
  );
});
test('Authentication problem stops every source durably', async () => {
  const h = harness();
  await h.guard.failure('feed', new LinkedInError('auth_required'));
  const restarted = new TrafficProtection(h.store, h.policy, h.clock, h.wait);
  await assert.rejects(
    restarted.run('jobs', async () => assert.fail()),
    rejectsCode('source_blocked'),
  );
  await assert.rejects(
    restarted.armProbe('search'),
    rejectsCode('source_blocked'),
  );
});
test('404 for a deleted item does not trigger account cooldown', async () => {
  const h = harness();
  await h.guard.failure('jobs', new LinkedInError('item_unavailable'));
  assert.equal((await h.guard.snapshot()).scopes.jobs.failures, 0);
  await h.guard.run('jobs', async () => {});
});
test('Manual confirmation permits only one probe, followed by a slow restart', async () => {
  const h = harness();
  await h.guard.failure('search', new LinkedInError('search_restricted'));
  await assert.rejects(
    h.guard.armProbe('search'),
    rejectsCode('protection_pause'),
  );
  h.advance(3600001);
  await h.guard.armProbe('search');
  assert.equal(await h.guard.cycleBudget('search', 30), 1);
  await h.guard.run('search', async () => {});
  await assert.rejects(
    h.guard.run('search', async () =>
      assert.fail('second request after probe'),
    ),
    rejectsCode('protection_pause'),
  );
  assert.equal((await h.guard.snapshot()).scopes.search.successes, 1);
});
test('Restart cannot erase an interrupted one-request probe', async () => {
  const h = harness();
  h.store.state.scopes.search.probe = 'running';
  await assert.rejects(
    h.guard.run('search', async () => assert.fail()),
    rejectsCode('source_blocked'),
  );
});
test('A per-cycle cap does not spend shared quota on a denied request', async () => {
  const h = harness();
  const client = new LinkedInClient(
    session,
    0,
    async () =>
      new Response('<html>ok</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    undefined,
    h.guard.forScope('feed'),
  );
  client.beginCycle(1);
  await client.get('/feed/foryou/');
  await assert.rejects(client.get('/feed/foryou/'), rejectsCode('budget'));
  assert.equal((await h.guard.snapshot()).events.length, 1);
});
test('Unsafe policy overrides fail validation', () => {
  for (const policy of [
    { hourlyRequests: 10000 },
    { dailyRequests: 10000 },
    { searchHourlyRequests: 100 },
    { minGapMs: 1 },
  ])
    assert.equal(protectionPolicySchema.safeParse(policy).success, false);
});
test('Failure is counted once when both client and parser propagate it', async () => {
  const h = harness(),
    error = new LinkedInError('network');
  await h.guard.failure('feed', error);
  await h.guard.failure('feed', error);
  assert.equal((await h.guard.snapshot()).scopes.feed.failures, 1);
});

test('Cold start and confirmed probes clamp even aggressive cycle settings', async () => {
  const h = harness();
  assert.equal(await h.guard.cycleBudget('feed', 500), 1);
  assert.equal(await h.guard.cycleBudget('search', 500), 1);
  assert.equal(await h.guard.cycleBudget('jobs', 500), 2);
  for (const scope of ['feed', 'search', 'jobs'] as const)
    h.store.state.scopes[scope].successes = 10;
  assert.equal(await h.guard.cycleBudget('feed', 500), 3);
  assert.equal(await h.guard.cycleBudget('search', 500), 2);
  assert.equal(await h.guard.cycleBudget('jobs', 500), 4);
});

test('Different clients serialize network operations through the durable lease', async () => {
  const h = harness();
  let releaseRequest!: () => void;
  let releaseWait!: () => void;
  let active = 0,
    maxActive = 0;
  const wait = async (ms: number) =>
    new Promise<void>((resolve) => {
      releaseWait = () => {
        h.advance(ms);
        resolve();
      };
    });
  const a = new TrafficProtection(h.store, h.policy, h.clock, wait),
    b = new TrafficProtection(h.store, h.policy, h.clock, wait);
  const first = a.run('feed', async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    active--;
  });
  while (!releaseRequest) await new Promise((resolve) => setImmediate(resolve));
  const second = b.run('search', async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    active--;
  });
  while (!releaseWait) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  releaseRequest();
  await first;
  releaseWait();
  await second;
  assert.equal(maxActive, 1);
});

test('Server Retry-After longer than a day is not shortened', async () => {
  const h = harness();
  const client = new LinkedInClient(
    session,
    0,
    async () =>
      new Response('', { status: 429, headers: { 'retry-after': '172800' } }),
    undefined,
    h.guard.forScope('jobs'),
  );
  await assert.rejects(
    client.get(
      '/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=frontend',
    ),
    rejectsCode('rate_limited'),
  );
  assert.equal((await h.guard.snapshot()).quietUntil - h.clock(), 172800000);
});

test('A recruiter post mentioning captcha does not look like an account restriction', async () => {
  const h = harness();
  const body =
    '<html><body><div componentkey="update-card-focus-FeedType_FLAGSHIP_SEARCH">Frontend vacancy: build a CAPTCHA UI. Security verification required in the product.</div></body></html>';
  const client = new LinkedInClient(
    session,
    0,
    async () =>
      new Response(body, { headers: { 'content-type': 'text/html' } }),
    undefined,
    h.guard.forScope('search'),
  );
  assert.equal(
    await client.get('/search/results/content/?keywords=frontend'),
    body,
  );
  assert.equal((await h.guard.snapshot()).scopes.search.hold, undefined);
});

test('Live transport cannot accidentally be constructed without durable protection', () => {
  assert.throws(
    () => new LinkedInClient(session, 0),
    (error: unknown) =>
      error instanceof LinkedInError &&
      error.code === 'configuration' &&
      error.reason === 'durable_protection_required',
  );
});
