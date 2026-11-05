import { readConfig } from '../../../packages/runtime/src/config.js';
import { createPool } from '../../../packages/runtime/src/db.js';
import { runService } from '../../../packages/runtime/src/service.js';
import { log } from '../../../packages/runtime/src/logger.js';
import { MockSource } from './sources/mock.js';
import { collect } from './collect.js';

const config = readConfig();
if (config.SOURCE_MODE !== 'mock')
  throw new Error('LinkedIn source not implemented; refusing to start');
const pool = createPool(config.DATABASE_URL);
const source = new MockSource();
await runService({
  name: 'collector',
  port: config.COLLECTOR_PORT,
  intervalMs: config.POLL_INTERVAL_MS,
  pool,
  tick: async () => {
    const count = await collect(source, pool);
    log('collector', 'poll_completed', { source: source.name, count });
  },
});
