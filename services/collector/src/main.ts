import { readConfig } from '../../../packages/runtime/src/config.js';
import { createPool } from '../../../packages/runtime/src/db.js';
import { runService } from '../../../packages/runtime/src/service.js';
import { log } from '../../../packages/runtime/src/logger.js';
import { MockSource } from './sources/mock.js';
import { LinkedInSource } from './sources/linkedin.js';
import { loadSettings } from './linkedin/settings.js';
import { LinkedInError } from './linkedin/errors.js';
import { collect } from './collect.js';

const config = readConfig();
const source =
  config.SOURCE_MODE === 'mock'
    ? new MockSource()
    : new LinkedInSource(await loadSettings(config.LINKEDIN_CONFIG_FILE));
const pool = createPool(config.DATABASE_URL);

await runService({
  name: 'collector',
  port: config.COLLECTOR_PORT,
  intervalMs: config.POLL_INTERVAL_MS,
  pool,
  tick: async (signal) => {
    let count: number;
    try {
      count = await collect(source, pool, signal);
    } catch (error) {
      log('collector', 'source_failed', {
        code: error instanceof LinkedInError ? error.code : 'internal',
      });
      throw error;
    }
    log('collector', 'poll_completed', { source: source.name, count });
  },
});
