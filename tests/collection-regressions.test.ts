import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInClient } from '../services/collector/src/linkedin/client.js';
import { LinkedInJobsSource } from '../services/collector/src/linkedin/jobs.js';
import { settingsSchema } from '../services/collector/src/linkedin/settings.js';
import { GlobalPostSearch } from '../services/collector/src/linkedin/global-search.js';
import { decodeSearchHtml } from '../services/collector/src/linkedin/search-html.js';
import { decodeFeedPage } from '../services/collector/src/linkedin/feed-pages.js';
import { continuation } from '../services/collector/src/linkedin/pagination.js';
const session = { liAt: 'OFFLINE', jsessionId: 'OFFLINE' };
const html = (value: string) =>
  new Response(value, { headers: { 'content-type': 'text/html' } });
const day = new Date().toISOString().slice(0, 10);
const cards = (ids: number[]) =>
  ids
    .map(
      (id) =>
        `<li data-entity-urn="urn:li:jobPosting:${id}"><h3 class="base-search-card__title">Software Engineer</h3><h4 class="base-search-card__subtitle">Company</h4><time datetime="${day}"></time></li>`,
    )
    .join('');
const detail =
  '<div class="show-more-less-html__markup">Ищем frontend разработчика в нашу команду. Удаленная работа и интересные задачи.</div>';
test('Unavailable first three Jobs cards no longer starve the fourth, including after restart', async () => {
  let saved: unknown;
  const state = {
    load: async () => saved,
    save: async (_key: string, value: unknown) => {
      saved = value;
    },
  };
  const requests: string[] = [];
  const request: typeof fetch = async (value) => {
    const url = new URL(String(value));
    requests.push(url.pathname);
    if (url.pathname.endsWith('/search'))
      return html(cards([12345671, 12345672, 12345673, 12345674]));
    return url.pathname.endsWith('12345674')
      ? html(detail)
      : new Response('', { status: 404 });
  };
  const settings = {
    ...settingsSchema.parse({
      sessionFile: 'offline',
      jobsKeywords: ['frontend'],
      jobsMaxPages: 1,
    }),
    jobsIntervalMs: 0,
  };
  assert.equal(
    (
      await new LinkedInJobsSource(
        new LinkedInClient(session, 0, request),
        settings,
        undefined,
        state,
      ).fetchPosts()
    ).length,
    0,
  );
  const result = await new LinkedInJobsSource(
    new LinkedInClient(session, 0, request),
    settings,
    undefined,
    state,
  ).fetchPosts();
  assert.equal(result.length, 1);
  assert.equal(requests.filter((path) => path.endsWith('12345671')).length, 1);
});
const id = (n = 0) => (BigInt(Date.now() - n * 1000) << 22n).toString();
const card = (value: string, text: string) =>
  `<div role="listitem" componentkey="update-card-focus-${value}-FeedType_FLAGSHIP_SEARCH"><a href="/in/recruiter/">Recruiter</a><div componentkey="translatable-commentary-shareId=${value}"><div data-testid="expandable-text-box">${text}</div></div></div>`;
test('HTML search follows a same-host next-page link instead of returning after page one', async () => {
  const first = id(),
    second = id(1);
  let requests = 0;
  const config = settingsSchema.parse({
    sessionFile: 'offline',
    keywords: ['frontend'],
    searchPathTemplate: '/search/results/content/?keywords={keywords}',
    maxPages: 3,
  });
  const client = new LinkedInClient(session, 0, async () =>
    html(
      ++requests === 1
        ? card(first, 'Ищем Frontend разработчика в команду') +
            '<a rel="next" href="/search/results/content/?keywords=frontend&amp;page=2">Next</a>'
        : card(second, 'Ищем React разработчика в команду'),
    ),
  );
  const posts = [];
  for await (const page of new GlobalPostSearch(client, config).pages(
    'frontend',
    new Set(),
  ))
    posts.push(...page.posts);
  assert.equal(requests, 2);
  assert.equal(posts.length, 2);
});
test('HTML repost keeps original vacancy text alongside the comment', () => {
  const original = card(id(), 'Делюсь вакансией').replace(
    '</div></div></div>',
    '</div></div><div componentkey="translatable-commentary-shareId=' +
      id(1) +
      '"><div data-testid="expandable-text-box">Ищем Frontend разработчика в нашу команду</div></div></div>',
  );
  assert.match(decodeSearchHtml(original)[0]!.text, /Ищем Frontend/);
});
test('Stream references resolve and literal salary survives', () => {
  const value = id();
  const input =
    'a:' +
    JSON.stringify({
      children: ['Ищем Frontend разработчика, зарплата ', '$3000', ' и ', '$b'],
    }) +
    '\nb:' +
    JSON.stringify('удаленная работа') +
    '\n0:' +
    JSON.stringify({
      componentKey: 'translatable-commentary-shareId=' + value,
      textProps: '$a',
    });
  const posts = decodeFeedPage(input);
  assert.equal(posts.length, 1);
  assert.match(posts[0]!.text, /\$3000/);
  assert.match(posts[0]!.text, /удаленная работа/);
});
test('Unknown streaming page fails visibly rather than looking like an empty feed', () =>
  assert.throws(() => decodeFeedPage('0:{"newUnrecognizedShape":true}')));
test('HTML pagination preserves escaped quotes in server tokens', () => {
  const value = {
    $type: 'proto.sdui.actions.requests.PaginationRequest',
    pagerId: 'com.linkedin.sdui.pagers.feed.mainFeed',
    requestedArguments: {
      payload: {
        startIndex: 10,
        requestType: 'Pagination',
        feedSortOrder: 'FeedSortOrder_RELEVANCE',
        token: 'a"b',
      },
    },
  };
  const input =
    '<script>self.__next_f.push(' +
    JSON.stringify([1, JSON.stringify(value)]) +
    ')</script>';
  const page = continuation(input, true, 'feed');
  assert.equal(
    JSON.parse(page!.body).paginationRequest.requestedArguments.payload.token,
    'a"b',
  );
});

test('Fresh search pages are checked before deep pagination consumes the budget', async () => {
  const { LinkedInSource } =
    await import('../services/collector/src/sources/linkedin.js');
  const config = settingsSchema.parse({
    sessionFile: 'offline',
    keywords: ['one', 'two'],
    searchPathTemplate: '/search/results/content/?keywords={keywords}',
    maxPages: 3,
    maxRequestsPerCycle: 2,
    requestIntervalMs: 1000,
  });
  const queried: string[] = [];
  const source = new LinkedInSource({ ...config, session }, async (input) => {
    const url = new URL(String(input));
    queried.push(url.searchParams.get('keywords')!);
    return html(
      card(id(queried.length), 'Ищем Frontend разработчика в нашу команду') +
        `<a rel="next" href="/search/results/content/?keywords=${url.searchParams.get('keywords')}&amp;page=2">Next</a>`,
    );
  });
  await source.fetchPosts();
  assert.deepEqual(queried, ['one', 'two']);
});

test('Current nested ContentUrnUgcPostUrn keys decode in HTML and streaming pages', () => {
  const value = id();
  const key = `translatable-commentary-FeTranslationUrn(contentUrnUgcPostUrn=ContentUrnUgcPostUrn(userGeneratedContentPostUrn=UserGeneratedContentPostUrn(userGeneratedContentId=${value})), targetLocale=ru)`;
  const body = card(value, 'Ищем Frontend разработчика в нашу команду').replace(
    'translatable-commentary-shareId=' + value,
    key,
  );
  assert.equal(decodeSearchHtml(body)[0]?.id, 'urn:li:ugcPost:' + value);
  assert.equal(
    decodeFeedPage(
      '0:' +
        JSON.stringify({
          componentKey: key,
          textProps: { children: 'Ищем Frontend разработчика в нашу команду' },
        }),
    )[0]?.id,
    'urn:li:ugcPost:' + value,
  );
});

test('Nested JSON strings preserve pagination tokens without stripping escapes', () => {
  const request = {
    $type: 'proto.sdui.actions.requests.PaginationRequest',
    pagerId: 'com.linkedin.sdui.pagers.feed.mainFeed',
    requestedArguments: {
      payload: {
        requestType: 'Pagination',
        feedSortOrder: 'FeedSortOrder_RELEVANCE',
        startIndex: 3,
        token: 'a"b',
      },
    },
  };
  const input =
    '<script>window.data=' +
    JSON.stringify(JSON.stringify(JSON.stringify(request))) +
    '</script>';
  const result = continuation(input, true, 'feed');
  assert.ok(result);
  assert.equal(
    JSON.parse(result.body).paginationRequest.requestedArguments.payload.token,
    'a"b',
  );
});

test('Small Jobs warm-up budgets rotate to the query that could not run', async () => {
  const settings = {
    ...settingsSchema.parse({
      sessionFile: 'offline',
      jobsKeywords: ['one', 'two', 'three'],
      jobsMaxPages: 1,
      jobsDetailsPerQuery: 1,
      jobsRequestBudget: 4,
    }),
    jobsIntervalMs: 0,
  };
  const queried: string[] = [];
  const source = new LinkedInJobsSource(
    new LinkedInClient(session, 0, async (value) => {
      const url = new URL(String(value));
      if (url.pathname.endsWith('/search')) {
        queried.push(url.searchParams.get('keywords')!);
        return html(cards([12345679]));
      }
      return html(detail);
    }),
    settings,
    undefined,
    undefined,
    {
      budget: async () => 2,
      failure: async () => {},
      run: async (operation) => operation(),
    },
  );
  await source.fetchPosts();
  await source.fetchPosts();
  assert.deepEqual(queried.slice(0, 2), ['one', 'two']);
});

test('A slower protected Jobs poll prioritizes unseen cards over old top results', async () => {
  const config = settingsSchema.parse({
    sessionFile: 'offline',
    jobsKeywords: ['frontend'],
    jobsMaxPages: 1,
    jobsDetailsPerQuery: 1,
  });
  const details: string[] = [];
  const source = new LinkedInJobsSource(
    new LinkedInClient(session, 0, async (value) => {
      const url = new URL(String(value));
      if (url.pathname.endsWith('/search'))
        return html(cards([12345671, 12345672]));
      details.push(url.pathname);
      return html(detail);
    }),
    config,
    async () => new Set(['urn:li:jobPosting:12345671']),
  );
  await source.fetchPosts();
  assert.deepEqual(details, ['/jobs-guest/jobs/api/jobPosting/12345672']);
});
