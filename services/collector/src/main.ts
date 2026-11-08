import { LinkedInJobsSource } from './linkedin/jobs.js';
import { LinkedInClient, RequestGate } from './linkedin/client.js';
import { readConfig } from '../../../packages/runtime/src/config.js';
import { createPool } from '../../../packages/runtime/src/db.js';
import { runService } from '../../../packages/runtime/src/service.js';
import type { ScheduledTask } from '../../../packages/runtime/src/scheduler.js';
import { log } from '../../../packages/runtime/src/logger.js';
import type { PostSource } from './sources/source.js';
import { MockSource } from './sources/mock.js';
import { LinkedInSource } from './sources/linkedin.js';
import { loadSettings } from './linkedin/settings.js';
import { LinkedInError } from './linkedin/errors.js';
import { collect } from './collect.js';
import { DatabaseState } from './state.js';
import { SourceMonitor } from './monitor.js';
const config = readConfig();
const pool = createPool(config.DATABASE_URL);
const state = new DatabaseState(pool);
const monitor = new SourceMonitor(pool, state);
await monitor.restore();
const settings =
  config.SOURCE_MODE === 'linkedin'
    ? await loadSettings(config.LINKEDIN_CONFIG_FILE)
    : undefined;
const knownPosts = async (urns: string[]) =>
  new Set<string>(
    (
      await pool.query<{ id: string }>(
        "SELECT id FROM processing.observations WHERE id=ANY($1::text[]) AND last_seen_at > now()-interval '30 minutes'",
        [urns],
      )
    ).rows.map((row) => row.id),
  );
const tasks: ScheduledTask[] = [];
function register(
  name: string,
  intervalMs: number,
  source: PostSource & {
    reports?: { status: string; posts: number; coverageLimited?: boolean }[];
    shouldPoll?: () => boolean;
  },
) {
  tasks.push({
    name,
    intervalMs,
    tick: async (signal) => {
      if (
        config.COLLECTION_PAUSED ||
        (source.shouldPoll && !source.shouldPoll())
      )
        return;
      let count = 0,
        failure: string | undefined;
      try {
        count = await collect(source, pool, signal, (value) => {
          count = value;
        });
      } catch (error) {
        if (signal.aborted) throw error;
        failure = error instanceof LinkedInError ? error.code : 'internal';
      }
      if (source.reports && !source.reports.length && !failure) return;
      await monitor.record(
        name,
        source.reports ?? [{ status: failure ?? 'ok', posts: count }],
        count,
        failure,
      );
      for (const report of source.reports ?? [])
        log('collector', 'target_result', { source: name, ...report });
      log('collector', 'poll_completed', {
        source: name,
        newPosts: count,
        status: failure ?? 'completed',
      });
    },
  });
}
if (settings) {
  const gate = new RequestGate();
  const feedBudget = settings.personalFeed
    ? Math.min(
        settings.personalFeedLoadMore + 1,
        settings.maxRequestsPerCycle - 1,
      )
    : 0;
  if (settings.personalFeed)
    register(
      'feed',
      config.FEED_POLL_INTERVAL_MS,
      new LinkedInSource(
        {
          ...settings,
          keywords: [],
          authorUrns: [],
          maxRequestsPerCycle: Math.max(1, feedBudget),
        },
        fetch,
        knownPosts,
        gate,
      ),
    );
  if (settings.keywords.length || settings.authorUrns.length)
    register(
      'search',
      config.POLL_INTERVAL_MS,
      new LinkedInSource(
        {
          ...settings,
          personalFeed: false,
          maxRequestsPerCycle: Math.max(
            1,
            settings.maxRequestsPerCycle - feedBudget,
          ),
        },
        fetch,
        knownPosts,
        gate,
      ),
    );
  if (settings.jobsKeywords.length)
    register(
      'jobs',
      settings.jobsIntervalMs,
      new LinkedInJobsSource(
        new LinkedInClient(
          settings.session,
          Math.max(5000, settings.requestIntervalMs),
        ),
        settings,
        knownPosts,
        state,
      ),
    );
} else register('mock', config.POLL_INTERVAL_MS, new MockSource());
await runService({
  name: 'collector',
  port: config.COLLECTOR_PORT,
  intervalMs: config.POLL_INTERVAL_MS,
  pool,
  tasks,
  readyCheck: () =>
    !config.COLLECTION_PAUSED &&
    monitor.ready(
      tasks.map((task) => ({ name: task.name, intervalMs: task.intervalMs })),
    ),
  diagnostics: async () => ({
    paused: config.COLLECTION_PAUSED,
    ...(await monitor.diagnostics()),
  }),
});
