import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelay } from '../packages/runtime/src/scheduler.js';
import {
  vacancyAliases,
  contentFingerprint,
} from '../packages/contracts/src/fingerprint.js';
import { formatNotification } from '../services/notifier/src/format.js';
import { MockSource } from '../services/collector/src/sources/mock.js';
test('Scheduler deducts elapsed time and never creates a catch-up burst', () => {
  assert.equal(nextDelay(180000, 0, 60000), 120000);
  assert.equal(nextDelay(180000, 0, 250000), 1000);
});
test('Duplicate identity requires evidence and ignores mutable observation time', async () => {
  const post = (await new MockSource().fetchPosts())[0]!;
  assert.equal(
    contentFingerprint(post),
    contentFingerprint({ ...post, firstSeenAt: new Date().toISOString() }),
  );
  assert.notEqual(
    contentFingerprint(post),
    contentFingerprint({ ...post, text: post.text + ' Зарплата повышена.' }),
  );
  assert.deepEqual(
    vacancyAliases({
      ...post,
      text: post.text + ' https://lnkd.in/shared',
    }).filter((alias) => alias.startsWith('application:')),
    [],
  );
});
test('Telegram shows location, salary, evidence and date without invented time', async () => {
  const original = (await new MockSource().fetchPosts())[0]!;
  const post = {
    ...original,
    kind: 'job' as const,
    title: 'Frontend Engineer',
    location: 'Worldwide',
    publishedPrecision: 'day' as const,
    text: 'We are hiring a frontend engineer.\nSalary: 4000 USD\nRemote\nRussian required\nEnglish B2 required',
  };
  const message = formatNotification(
    { post, roles: ['frontend'], russian: false },
    true,
    true,
  );
  assert.match(message, /4000 USD/);
  assert.match(message, /Worldwide/);
  assert.match(message, /Russian required/);
  assert.match(message, /English B2/);
  assert.doesNotMatch(message, /\d{2}:\d{2}/);
});

test('Native job source identity survives title corrections', async () => {
  const post = (await new MockSource().fetchPosts())[0]!;
  const a = {
    ...post,
    kind: 'job' as const,
    id: 'urn:li:jobPosting:12345678',
    title: 'Frontend Engineer',
  };
  const b = { ...a, title: 'Senior Frontend Engineer' };
  assert.ok(
    vacancyAliases(a).some((alias) => vacancyAliases(b).includes(alias)),
  );
});

test('OCR enrichment makes Russian image text eligible and preserves the source', async () => {
  const { enrichImages } = await import('../services/processor/src/ocr.js');
  const { vacancyRoles, classifyPost } =
    await import('../packages/contracts/src/classifier.js');
  const post = (await new MockSource().fetchPosts())[0]!;
  const image = {
    ...post,
    text: '[Текст вакансии на изображении]',
    imageUrls: [
      'https://media.licdn.com/dms/image/v2/example/feedshare-shrink_800/test',
    ],
  };
  const enriched = await enrichImages(
    image,
    'http://ocr:3104',
    async () =>
      new Response(
        JSON.stringify({
          text: 'Ищем Frontend разработчика в нашу команду. Удаленная работа и интересные задачи.',
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  assert.deepEqual(vacancyRoles(classifyPost(enriched)), ['frontend']);
  assert.equal(enriched.url, image.url);
  assert.equal(enriched.ocrApplied, true);
});
test('OCR only accepts LinkedIn content images, excluding arbitrary hosts and avatars', async () => {
  const { vacancyImageUrl } =
    await import('../packages/contracts/src/media.js');
  assert.equal(vacancyImageUrl('https://127.0.0.1/dms/image/feedshare'), false);
  assert.equal(
    vacancyImageUrl('https://media.licdn.com.evil.test/dms/image/feedshare'),
    false,
  );
  assert.equal(
    vacancyImageUrl(
      'https://media.licdn.com/dms/image/profile-displayphoto-shrink_800',
    ),
    false,
  );
  assert.equal(
    vacancyImageUrl(
      'https://media.licdn.com/dms/image/v2/example/feedshare-shrink_800/test',
    ),
    true,
  );
});
