import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../packages/runtime/src/config.js';
import { postSchema } from '../packages/contracts/src/index.js';
import { MockSource } from '../services/collector/src/sources/mock.js';
test('Defaults never send messages', () => {
  const config = readConfig({ DATABASE_URL: 'postgres://localhost/test' });
  assert.equal(config.SOURCE_MODE, 'mock');
  assert.equal(config.TELEGRAM_MODE, 'dry-run');
});
test('Live mode rejects missing credentials and mock data', () => {
  assert.throws(() =>
    readConfig({ DATABASE_URL: 'test', TELEGRAM_MODE: 'live' }),
  );
  assert.throws(() =>
    readConfig({
      DATABASE_URL: 'test',
      TELEGRAM_MODE: 'live',
      TELEGRAM_BOT_TOKEN: 'secret',
      TELEGRAM_CHAT_ID: '1',
    }),
  );
});
test('Invalid intervals rejected', () =>
  assert.throws(() =>
    readConfig({ DATABASE_URL: 'test', POLL_INTERVAL_MS: '0' }),
  ));
test('Reject non-LinkedIn links and invalid dates', async () => {
  const post = (await new MockSource().fetchPosts())[0]!;
  assert.equal(postSchema.safeParse(post).success, true);
  assert.equal(
    postSchema.safeParse({
      ...post,
      url: 'https://linkedin.com.evil.test/post',
    }).success,
    false,
  );
  assert.equal(
    postSchema.safeParse({ ...post, publishedAt: 'yesterday' }).success,
    false,
  );
});
