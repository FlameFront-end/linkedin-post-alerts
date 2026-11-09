import { TrafficProtection, minimumPollMs } from './linkedin/protection.js';
import { DatabaseProtectionStore } from './linkedin/protection-store.js';
import { LinkedInJobsSource } from './linkedin/jobs.js';
import { LinkedInClient } from './linkedin/client.js';
import { readConfig } from '../../../packages/runtime/src/config.js';
import { createPool } from '../../../packages/runtime/src/db.js';
import { runService } from '../../../packages/runtime/src/service.js';
import type { ScheduledTask } from '../../../packages/runtime/src/scheduler.js';
import {
  log,
  errorFields,
  failureLevel,
} from '../../../packages/runtime/src/logger.js';
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
const knownJobs = async (urns: string[]) =>
  new Set<string>(
    (
      await pool.query<{ id: string }>(
        'SELECT id FROM processing.observations WHERE id=ANY($1::text[])',
        [urns],
      )
    ).rows.map((row) => row.id),
  );
const protection = new TrafficProtection(
  new DatabaseProtectionStore(pool),
  settings?.protection,
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
  if (source instanceof LinkedInSource)
    source.onPage = (page) =>
      log('collector', 'page_decoded', { source: name, ...page });
  let lastSkip = 0;
  tasks.push({
    name,
    intervalMs,
    tick: async (signal) => {
      if (
        config.COLLECTION_PAUSED ||
        (source.shouldPoll && !source.shouldPoll())
      ) {
        if (Date.now() - lastSkip >= 3600000) {
          lastSkip = Date.now();
          log('collector', 'poll_skipped', {
            source: name,
            reason: config.COLLECTION_PAUSED ? 'operator_pause' : 'not_due',
          });
        }
        return;
      }
      if (
        name === 'jobs' &&
        (await protection.snapshot()).scopes.jobs.hold === 'jobs_rate_limited'
      ) {
        if (Date.now() - lastSkip >= 3600000) {
          lastSkip = Date.now();
          log('collector', 'poll_skipped', {
            source: name,
            reason: 'jobs_quarantined',
          });
        }
        return;
      }
      log('collector', 'poll_started', { source: name });
      let count = 0,
        failure: string | undefined;
      try {
        count = await collect(source, pool, signal, (value) => {
          count = value;
        });
      } catch (error) {
        if (signal.aborted) throw error;
        failure = error instanceof LinkedInError ? error.code : 'internal';
        log(
          'collector',
          'source_failed',
          { source: name, ...errorFields(error) },
          failureLevel(failure),
        );
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
  const feedBudget = settings.personalFeed
    ? Math.min(
        settings.personalFeedLoadMore + 1,
        settings.maxRequestsPerCycle - 1,
      )
    : 0;
  if (settings.personalFeed)
    register(
      'feed',
      Math.max(minimumPollMs.feed, config.FEED_POLL_INTERVAL_MS),
      new LinkedInSource(
        {
          ...settings,
          keywords: [],
          authorUrns: [],
          maxRequestsPerCycle: Math.max(1, feedBudget),
        },
        fetch,
        knownPosts,
        undefined,
        protection.forScope('feed'),
        state,
      ),
    );
  if (settings.keywords.length || settings.authorUrns.length)
    register(
      'search',
      Math.max(minimumPollMs.search, config.POLL_INTERVAL_MS),
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
        undefined,
        protection.forScope('search'),
      ),
    );
  if (settings.jobsKeywords.length)
    register(
      'jobs',
      Math.max(minimumPollMs.jobs, settings.jobsIntervalMs),
      new LinkedInJobsSource(
        new LinkedInClient(
          settings.session,
          Math.max(5000, settings.requestIntervalMs),
          fetch,
          undefined,
          protection.forScope('jobs'),
        ),
        settings,
        knownJobs,
        state,
        protection.forScope('jobs'),
      ),
    );
} else register('mock', config.POLL_INTERVAL_MS, new MockSource());
await runService({
  name: 'collector',
  port: config.COLLECTOR_PORT,
  intervalMs: config.POLL_INTERVAL_MS,
  pool,
  tasks,
  readyCheck: async () => {
    const guard = await protection.snapshot();
    return (
      !config.COLLECTION_PAUSED &&
      monitor.ready(
        tasks
          .filter(
            (task) =>
              !(
                task.name === 'jobs' &&
                guard.scopes.jobs.hold === 'jobs_rate_limited'
              ),
          )
          .map((task) => ({ name: task.name, intervalMs: task.intervalMs })),
      )
    );
  },
  diagnostics: async () => {
    const guard = await protection.snapshot();
    const disabledSources =
      guard.scopes.jobs.hold === 'jobs_rate_limited' ? ['jobs'] : [];
    return {
      paused: config.COLLECTION_PAUSED,
      protection: guard,
      disabledSources,
      degraded: disabledSources.length > 0,
      limits: settings?.protection,
      feedDeepIntervalMs: settings?.feedDeepIntervalMs,
      schedule: tasks.map((task) => ({
        source: task.name,
        intervalMs: task.intervalMs,
      })),
      ...(await monitor.diagnostics()),
    };
  },
});
