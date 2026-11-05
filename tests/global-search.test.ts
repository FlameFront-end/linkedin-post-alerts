import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSearch } from '../services/collector/src/linkedin/search.js';
import { decodeDetails } from '../services/collector/src/linkedin/details.js';
import { settingsSchema } from '../services/collector/src/linkedin/settings.js';
import { LinkedInClient } from '../services/collector/src/linkedin/client.js';
import { GlobalPostSearch } from '../services/collector/src/linkedin/global-search.js';
import { LinkedInSource } from '../services/collector/src/sources/linkedin.js';

// Synthetic normalized fixtures: no claim that current authenticated LinkedIn uses this queryId/shape.
const urn = `urn:li:activity:${(BigInt(Date.now()) << 22n).toString()}`;
const card = {
  entityUrn: 'card-ref',
  $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel',
  navigationUrl: `https://www.linkedin.com/posts/recruiter_job-activity-${urn.split(':').at(-1)}-ABCD`,
  summary: { text: 'TRUNCATED SEARCH SUMMARY' },
};
function searchPage(start = 0, total = 20) {
  return {
    data: {
      data: {
        searchDashClustersByAll: {
          elements: [{ items: [{ item: { '*entityResult': 'card-ref' } }] }],
          paging: { start, count: 10, total },
        },
      },
    },
    included: [
      { ...card },
      {
        ...card,
        entityUrn: 'unrelated',
        navigationUrl: 'https://evil.test/posts/foo',
      },
    ],
  };
}
const detail = {
  data: { data: { result: { '*elements': ['update-ref'] } } },
  included: [
    {
      entityUrn: 'update-ref',
      $type: 'com.linkedin.voyager.dash.feed.Update',
      metadata: { backendUrn: urn },
      commentary: {
        text: { text: 'Ищем Frontend разработчика. FULL POST TEXT' },
      },
      actor: { name: { text: 'Unknown Recruiter' } },
    },
  ],
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const session = { liAt: 'SECRET', jsessionId: 'ajax:SESSION' };
function settings() {
  return settingsSchema.parse({
    sessionFile: 'x',
    keywords: ['frontend вакансия'],
    searchPathTemplate:
      '/voyager/api/graphql?keywords={keywords}&start={start}&count={count}',
    maxPages: 2,
  });
}

test('Finds normalized cards across multiple clusters without requiring known authors', () => {
  const body = searchPage();
  body.data.data.searchDashClustersByAll.elements.push({
    items: [{ item: { '*entityResult': 'card-ref' } }],
  });
  const page = decodeSearch(body);
  assert.equal(page.references.length, 1);
  assert.equal(page.references[0]?.urn, urn);
  assert.equal(page.nextStart, 10); // cluster count is NOT the result offset
  assert.ok(page.references[0]?.slug);
});
test('Full text comes from detail response, never summary', () => {
  const ref = decodeSearch(searchPage()).references[0]!;
  const post = decodeDetails(detail, ref)!;
  assert.equal(post.author, 'Unknown Recruiter');
  assert.ok(post.text.includes('FULL POST TEXT'));
  assert.ok(!post.text.includes('SUMMARY'));
  assert.throws(() => decodeDetails({ data: {} }, ref));
});
test('Empty and broken search results are distinguished', () => {
  assert.equal(
    decodeSearch({
      data: { elements: [], paging: { start: 0, count: 10, total: 0 } },
    }).empty,
    true,
  );
  assert.throws(() =>
    decodeSearch({
      data: { elements: [{ $type: 'FeedbackCard' }], paging: { start: 0 } },
    }),
  );
  const body = searchPage();
  body.included[0]!.navigationUrl = 'https://evil.test/post';
  assert.throws(() => decodeSearch(body));
});
test('Hydrates once across pages/queries; cached full posts remain available for enqueue retries', async () => {
  let details = 0;
  const starts: string[] = [];
  const client = new LinkedInClient(session, 0, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/graphql')) {
      starts.push(url.searchParams.get('start')!);
      return response(searchPage(Number(url.searchParams.get('start'))));
    }
    details++;
    return response(detail);
  });
  const engine = new GlobalPostSearch(client, settings());
  const seen = new Set<string>();
  const posts = [];
  for await (const page of engine.pages('frontend вакансия', seen))
    posts.push(...page.posts);
  assert.deepEqual(starts, ['0', '10']);
  assert.equal(posts.length, 1);
  assert.equal(details, 1);
  for await (const _page of engine.pages('React ищем', seen)) {
  }
  assert.equal(details, 1);
  const retryPosts = [];
  for await (const page of engine.pages('frontend вакансия', new Set()))
    retryPosts.push(...page.posts);
  assert.equal(retryPosts.length, 1);
  assert.equal(details, 1);
});
test('Global source runs without any author URNs', async () => {
  const config = settings();
  config.maxPages = 1;
  const source = new LinkedInSource({ ...config, session }, async (input) =>
    response(
      new URL(String(input)).pathname.endsWith('/graphql')
        ? searchPage(0, 1)
        : detail,
    ),
  );
  const posts = await source.fetchPosts();
  assert.equal(posts.length, 1);
  assert.equal(source.reports[0]?.kind, 'keyword');
  assert.equal(source.reports[0]?.status, 'ok');
});

test('Media-only detail does not disable a global query', () => {
  const ref = decodeSearch(searchPage()).references[0]!;
  assert.equal(
    decodeDetails(
      {
        data: {
          metadata: { backendUrn: urn },
          $type: 'com.linkedin.voyager.dash.feed.Update',
          content: { imageComponent: {} },
        },
      },
      ref,
    ),
    undefined,
  );
});
