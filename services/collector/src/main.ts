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
const source: PostSource =
  config.SOURCE_MODE === 'mock'
    ? new MockSource()
    : new LinkedInSource(
        await loadSettings(config.LINKEDIN_CONFIG_FILE),
        fetch,
        knownPosts,
      );

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
      throw error;
    }
    if (source instanceof LinkedInSource)
      for (const report of source.reports)
        log('collector', 'target_result', report);
    log('collector', 'poll_completed', { source: source.name, count });
    await alertOwner();
  },
});
