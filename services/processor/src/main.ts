import { readConfig } from '../../../packages/runtime/src/config.js';
import { createPool } from '../../../packages/runtime/src/db.js';
import { runService } from '../../../packages/runtime/src/service.js';
import { processNext } from './process.js';
const config = readConfig();
const pool = createPool(config.DATABASE_URL);
await runService({
  name: 'processor',
  port: config.PROCESSOR_PORT,
  intervalMs: config.WORKER_INTERVAL_MS,
  pool,
  tick: async (signal) => {
    for (let i = 0; i < 25 && !signal.aborted; i++) {
      if (!(await processNext(pool))) break;
    }
  },
});
