import { readConfig } from '../../../packages/runtime/src/config.js';
import { createPool } from '../../../packages/runtime/src/db.js';
import { runService } from '../../../packages/runtime/src/service.js';
import { log } from '../../../packages/runtime/src/logger.js';
import { purgeCompleted } from '../../../packages/queue/src/index.js';
import { processNext } from './process.js';
const config = readConfig();
const pool = createPool(config.DATABASE_URL);
const PURGE_EVERY_MS = 3_600_000;
let lastPurge = 0;
await runService({
  name: 'processor',
  port: config.PROCESSOR_PORT,
  intervalMs: config.WORKER_INTERVAL_MS,
  pool,
  tick: async (signal) => {
    for (let i = 0; i < 25 && !signal.aborted; i++) {
      if (!(await processNext(pool, config.SOURCE_MODE === 'linkedin'))) break;
    }
    if (Date.now() - lastPurge >= PURGE_EVERY_MS) {
      lastPurge = Date.now();
      const removed = await purgeCompleted(pool, config.RETENTION_DAYS);
      if (removed.jobs || removed.posts)
        log('processor', 'retention_purged', removed);
    }
  },
});
