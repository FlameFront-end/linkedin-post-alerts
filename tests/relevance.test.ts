import { formatNotification } from '../services/notifier/src/format.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  classifyPost,
  languageMatch,
  vacancyRoles,
} from '../packages/contracts/src/classifier.js';
import {
  decodeJobCards,
  decodeJobDetails,
  LinkedInJobsSource,
} from '../services/collector/src/linkedin/jobs.js';
import { LinkedInClient } from '../services/collector/src/linkedin/client.js';
import { settingsSchema } from '../services/collector/src/linkedin/settings.js';

for (const [sentence, expected] of [
  ['Russian language required due to client-side communication', 'required'],
  ['Russian is required (written and spoken)', 'required'],
  ['Requirements\n• Fluent Russian\n• React experience', 'required'],
  ['Russian is a must, English B1+', 'required'],
  ['Russian is not required', 'none'],
  ['Russian — a plus (large part of team is Russian-speaking)', 'none'],
  ['Russian optional, English required', 'none'],
  ['Russian or Ukrainian language — fluent (required)', 'none'],
  ['Our Russian office has been growing for years', 'none'],
] as const)
  test(sentence, () => assert.equal(languageMatch(sentence), expected));

test('Russian recruiting text with a long English stack passes', () => {
  assert.equal(
    languageMatch(
      'Ищем разработчика в команду. Нужен опыт работы и желание развивать продукт. Стек React Vue Angular TypeScript JavaScript Node Docker Kubernetes Redux Next Nuxt CSS HTML AWS PostgreSQL Redis Git.',
    ),
    'russian',
  );
});
test('Hiring post addressing job seekers survives the candidate filter', () => {
  assert.deepEqual(
    vacancyRoles(
      classify(
        'We are hiring a frontend engineer. If you are looking for a job, apply now. Fluent Russian required.',
      ),
    ),
    ['frontend'],
  );
  assert.deepEqual(
    vacancyRoles(classify("I'm looking for a frontend role. Fluent Russian.")),
    [],
  );
});
const now = new Date();
const date = now.toISOString().slice(0, 10);
const list = `<li><div data-entity-urn="urn:li:jobPosting:12345678"><h3 class="base-search-card__title">Frontend Developer</h3><h4 class="base-search-card__subtitle">Example</h4><span class="job-search-card__location">Remote</span><time datetime="${date}"></time></div></li>`;
const detail =
  '<div class="show-more-less-html__markup"><p>Develop user interfaces using React and TypeScript.</p><h3>Requirements</h3><ul><li>Russian is required for client communication.</li></ul></div>';
test('Native job keeps its identity and uses title rather than backend mentions for role', () => {
  const cards = decodeJobCards(list);
  const post = decodeJobDetails(detail, cards[0]!)!;
  assert.equal(post.kind, 'job');
  assert.equal(post.id, 'urn:li:jobPosting:12345678');
  assert.deepEqual(vacancyRoles(classifyPost(post)), ['frontend']);
  assert.deepEqual(
    vacancyRoles(
      classifyPost({
        ...post,
        title: 'Backend Developer',
        text: post.text + ' We integrate frontend React components.',
      }),
    ),
    [],
  );
});
test('Job source uses public HTML without sending session cookies', async () => {
  const settings = settingsSchema.parse({
    sessionFile: 'test',
    jobsKeywords: ['frontend Russian'],
    jobsDetailsPerQuery: 1,
  });
  let calls = 0;
  const client = new LinkedInClient(
    { liAt: 'SECRET', jsessionId: 'SECRET' },
    0,
    async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).cookie, undefined);
      calls++;
      return new Response(calls === 1 ? list : detail, {
        headers: { 'content-type': 'text/html' },
      });
    },
  );
  const source = new LinkedInJobsSource(client, settings);
  assert.equal((await source.fetchPosts()).length, 1);
  assert.equal(calls, 2);
  assert.equal(source.shouldPoll(), false);
});
test('Jobs 429 applies backoff and does not proceed to other queries', async () => {
  const settings = settingsSchema.parse({
    sessionFile: 'test',
    jobsKeywords: ['frontend Russian', 'fullstack Russian'],
  });
  let calls = 0;
  const source = new LinkedInJobsSource(
    new LinkedInClient(
      { liAt: 'SECRET', jsessionId: 'SECRET' },
      0,
      async () => {
        calls++;
        return new Response('', {
          status: 429,
          headers: { 'retry-after': '3600' },
        });
      },
    ),
    settings,
  );
  await source.fetchPosts();
  assert.equal(calls, 1);
  assert.equal(source.reports[0]?.status, 'rate_limited');
  assert.equal(source.shouldPoll(), false);
});

test('Russian mandatory clause in English job description passes', () =>
  assert.equal(
    languageMatch('We need React experience. Русский язык обязателен.'),
    'required',
  ));

test('English optional does not negate mandatory Russian', () =>
  assert.equal(
    languageMatch('Russian required, English optional'),
    'required',
  ));

test('HTTP 200 verification screen halts the source as an access error', async () => {
  const client = new LinkedInClient(
    { liAt: 'SECRET', jsessionId: 'SECRET' },
    0,
    async () =>
      new Response(
        '<html><body>Наши системы обнаружили необычный трафик</body></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
  );
  await assert.rejects(
    client.get('/search/results/content/?keywords=React'),
    (error: unknown) =>
      error instanceof Error && error.message === 'LinkedIn: auth_required',
  );
});

test('Native job card retains first paragraph and shows the Russian requirement', () => {
  const post = decodeJobDetails(detail, decodeJobCards(list)[0]!)!;
  const card = formatNotification(
    { post, roles: ['frontend'], russian: false },
    true,
    true,
  );
  assert.match(card, /Frontend Developer/);
  assert.match(card, /Develop user interfaces/);
  assert.match(card, /Русский обязателен/);
  assert.match(card, /Открыть вакансию/);
});
