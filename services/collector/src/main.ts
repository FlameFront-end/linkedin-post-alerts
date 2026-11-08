import { LinkedInJobsSource } from './linkedin/jobs.js';
import { LinkedInClient } from './linkedin/client.js';
import { readConfig } from '../../../packages/runtime/src/config.js';
import { createPool } from '../../../packages/runtime/src/db.js';
import { runService } from '../../../packages/runtime/src/service.js';
import { log } from '../../../packages/runtime/src/logger.js';
import type { PostSource } from './sources/source.js';
import { MockSource } from './sources/mock.js';
import { LinkedInSource } from './sources/linkedin.js';
import { loadSettings } from './linkedin/settings.js';
import { LinkedInError } from './linkedin/errors.js';
import { collect } from './collect.js';
import { alertFor, raiseAlert } from './alerts.js';

const config = readConfig();
const pool = createPool(config.DATABASE_URL);
// Posts already in the durable queue are not fetched again from LinkedIn.
const knownPosts = async (urns: string[]) => {
  if (!urns.length) return new Set<string>();
  const result = await pool.query<{ dedupe_key: string }>(
    `SELECT dedupe_key FROM queue.jobs WHERE kind='post' AND dedupe_key = ANY($1::text[])`,
    [urns],
  );
  return new Set(result.rows.map((row) => row.dedupe_key));
};
const settings =
  config.SOURCE_MODE === 'linkedin'
    ? await loadSettings(config.LINKEDIN_CONFIG_FILE)
    : undefined;
const jobs = settings?.jobsKeywords.length
  ? new LinkedInJobsSource(
      new LinkedInClient(
        settings.session,
        Math.max(5000, settings.requestIntervalMs),
      ),
      settings,
      knownPosts,
    )
  : undefined;
const source: PostSource =
  config.SOURCE_MODE === 'mock'
    ? new MockSource()
    : new LinkedInSource(settings!, fetch, knownPosts);

async function alertOwner(error?: unknown) {
  if (!(source instanceof LinkedInSource)) return;
  const draft = alertFor(source, error);
  if (!draft) return;
  try {
    await raiseAlert(pool, draft);
  } catch {
    log('collector', 'alert_failed', { code: draft.code });
  }
}

await runService({
  name: 'collector',
  port: config.COLLECTOR_PORT,
  intervalMs: config.POLL_INTERVAL_MS,
  pool,
  readyCheck: () => source.isReady?.() ?? true,
  tick: async (signal) => {
    let count: number;
    try {
      count = await collect(source, pool, signal);
    } catch (error) {
      log('collector', 'source_failed', {
        code: error instanceof LinkedInError ? error.code : 'internal',
      });
      if (!signal.aborted) await alertOwner(error);
      if (signal.aborted) throw error;
      count = 0;
    }
    if (jobs?.shouldPoll() && !signal.aborted) {
      try {
        const count = await collect(jobs, pool, signal);
        log('collector', 'jobs_completed', { count });
      } catch {
        log('collector', 'jobs_failed');
      }
      for (const report of jobs.reports)
        log('collector', 'jobs_target', report);
    }
    if (source instanceof LinkedInSource)
      for (const report of source.reports)
        log('collector', 'target_result', report);
    log('collector', 'poll_completed', { source: source.name, count });
    await alertOwner();
  },
});
