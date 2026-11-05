import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LinkedInClient,
  checkedUrl,
} from '../services/collector/src/linkedin/client.js';
import { LinkedInError } from '../services/collector/src/linkedin/errors.js';
import { decodePosts } from '../services/collector/src/linkedin/decode.js';
import { settingsSchema } from '../services/collector/src/linkedin/settings.js';
import { LinkedInSource } from '../services/collector/src/sources/linkedin.js';

// Synthetic fixtures based on the documented UpdateV2 structure, NOT captured live responses.
const now = new Date('2026-11-05T12:00:00.000Z');
const id = (BigInt(now.getTime()) << 22n).toString();
const urn = `urn:li:activity:${id}`;
const entry = {
  entityUrn: urn,
  updateMetadata: { urn },
  commentary: { text: { text: 'Ищем DevOps' } },
  actor: { name: { text: 'Recruiter' } },
};
const fixture = {
  data: { '*elements': [urn], paging: { start: 0, count: 10, total: 1 } },
  included: [
    entry,
    {
      ...entry,
      entityUrn: 'urn:unrelated',
      updateMetadata: { urn: 'urn:li:activity:1' },
    },
  ],
};
const session = { liAt: 'SECRET', jsessionId: '"ajax:SESSION"' };
const json = (data: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

test('Decodes reachable normalized posts and timestamp from activity ID', () => {
  const result = decodePosts(fixture, now);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0]?.publishedAt, now.toISOString());
  assert.equal(result.posts[0]?.author, 'Recruiter');
  assert.equal(result.posts[0]?.text, 'Ищем DevOps');
});
test('Explicit empty collection is valid; unknown and feedback-only responses fail', () => {
  assert.deepEqual(
    decodePosts({ data: { elements: [], paging: { start: 0, total: 0 } } }, now)
      .posts,
    [],
  );
  assert.throws(() => decodePosts({ included: [] }, now), LinkedInError);
  assert.throws(
    () =>
      decodePosts(
        {
          data: { elements: [{ $type: 'FeedbackCard' }], paging: { start: 0 } },
        },
        now,
      ),
    LinkedInError,
  );
});
test('HTTP sends session only to LinkedIn and never follows redirects', async () => {
  const request: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).origin, 'https://www.linkedin.com');
    assert.equal(init?.redirect, 'manual');
    assert.equal(
      (init?.headers as Record<string, string>)['csrf-token'],
      'ajax:SESSION',
    );
    assert.ok(
      (init?.headers as Record<string, string>).cookie?.includes(
        'li_at=SECRET',
      ),
    );
    return json(fixture);
  };
  await new LinkedInClient(session, 0, request).get('/voyager/api/me');
  for (const path of [
    'https://evil.test/voyager/api/me',
    '//evil.test/voyager/api/me',
    '/voyager/api/../../evil',
  ])
    assert.throws(() => checkedUrl(path));
});
test('Auth redirects, rate limits, HTML and GraphQL errors are explicit', async () => {
  for (const [response, code] of [
    [
      new Response('', {
        status: 302,
        headers: { location: 'https://evil.test' },
      }),
      'auth_required',
    ],
    [json({}, 429, { 'retry-after': '120' }), 'rate_limited'],
    [
      new Response('<html>login</html>', {
        headers: { 'content-type': 'text/html' },
      }),
      'response_format',
    ],
    [json({ errors: [{ message: 'sensitive response' }] }), 'response_format'],
  ] as const) {
    await assert.rejects(
      new LinkedInClient(session, 0, async () => response).get(
        '/voyager/api/me',
      ),
      (e: unknown) =>
        e instanceof LinkedInError &&
        e.code === code &&
        !e.message.includes('SECRET'),
    );
  }
});
test('Response size is bounded while streaming', async () => {
  await assert.rejects(
    new LinkedInClient(
      session,
      0,
      async () =>
        new Response('x'.repeat(4 * 1024 * 1024 + 1), {
          headers: { 'content-type': 'application/json' },
        }),
    ).get('/voyager/api/me'),
    (e: unknown) =>
      e instanceof LinkedInError && e.code === 'response_too_large',
  );
});
test('Search requires captured template; zero targets rejected', () => {
  assert.equal(
    settingsSchema.safeParse({ sessionFile: 'session.json' }).success,
    false,
  );
  assert.equal(
    settingsSchema.safeParse({
      sessionFile: 'session.json',
      keywords: ['DevOps'],
    }).success,
    false,
  );
});
test('Source paginates with bounded pages; passes only fresh posts', async () => {
  let calls = 0;
  const settings = settingsSchema.parse({
    sessionFile: 'x',
    authorUrns: ['urn:li:fsd_profile:ABC'],
    maxPages: 2,
  });
  const freshId = (BigInt(Date.now()) << 22n).toString();
  const fresh = {
    ...entry,
    updateMetadata: { urn: `urn:li:activity:${freshId}` },
  };
  const source = new LinkedInSource({ ...settings, session }, async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('profileUrn'), 'urn:li:fsd_profile:ABC');
    assert.equal(url.searchParams.get('start'), String(calls * 10));
    calls++;
    return json({
      data: {
        elements: [fresh],
        paging: { start: (calls - 1) * 10, total: 100 },
      },
    });
  });
  assert.equal((await source.fetchPosts()).length, 2);
  assert.equal(calls, 2);
});
test('Authentication failure halts future requests without another HTTP call', async () => {
  let calls = 0;
  const settings = settingsSchema.parse({
    sessionFile: 'x',
    authorUrns: ['urn:li:fsd_profile:ABC'],
  });
  const source = new LinkedInSource({ ...settings, session }, async () => {
    calls++;
    return json({}, 401);
  });
  await assert.rejects(source.fetchPosts());
  await assert.rejects(source.fetchPosts());
  assert.equal(calls, 1);
});

test('Resolves collection references and rejects false empty results', () => {
  assert.equal(
    decodePosts(
      {
        data: { '*result': 'collection' },
        included: [
          {
            entityUrn: 'collection',
            elements: [entry],
            paging: { start: 0, total: 1 },
          },
        ],
      },
      now,
    ).posts.length,
    1,
  );
  assert.throws(() =>
    decodePosts(
      { data: { elements: [], paging: { start: 0, total: 10 } } },
      now,
    ),
  );
});
test('429 pauses subsequent polls without spending more HTTP requests', async () => {
  let calls = 0;
  const settings = settingsSchema.parse({
    sessionFile: 'x',
    authorUrns: ['urn:li:fsd_profile:ABC'],
  });
  const source = new LinkedInSource({ ...settings, session }, async () => {
    calls++;
    return json({}, 429, { 'retry-after': '120' });
  });
  await assert.rejects(source.fetchPosts());
  assert.equal(source.isReady(), false);
  await assert.rejects(
    source.fetchPosts(),
    (error: unknown) =>
      error instanceof LinkedInError && error.code === 'cooldown',
  );
  assert.equal(calls, 1);
});
