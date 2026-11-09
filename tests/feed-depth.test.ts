import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedDepthSchedule } from '../services/collector/src/linkedin/feed-depth.js';
import { minimumPollMs } from '../services/collector/src/linkedin/protection.js';
test('Frequent feed refresh does not repeat deep pagination and survives restart', async () => {
  let now = Date.now();
  let saved: unknown;
  const state = {
    load: async () => saved,
    save: async (_key: string, value: unknown) => {
      saved = value;
    },
  };
  const schedule = new FeedDepthSchedule(900000, state, () => now);
  for (let i = 0; i < 3; i++) {
    assert.equal(await schedule.due(), false);
    now += 300000;
  }
  const restarted = new FeedDepthSchedule(900000, state, () => now);
  assert.equal(await restarted.due(), true);
  assert.equal(await restarted.due(), false);
  assert.equal(
    await new FeedDepthSchedule(900000, state, () => now).due(),
    false,
  );
  now += 900000;
  assert.equal(await restarted.due(), true);
});
test('Feed frequency is independent from post search and Jobs', () => {
  assert.equal(minimumPollMs.feed, 300000);
  assert.equal(minimumPollMs.search, 1800000);
  assert.equal(minimumPollMs.jobs, 3600000);
});
