import { readConfig } from '../../../packages/runtime/src/config.js';
import { createPool } from '../../../packages/runtime/src/db.js';
import { runService } from '../../../packages/runtime/src/service.js';
import { log } from '../../../packages/runtime/src/logger.js';
import { TelegramSender, type Sender } from './sender.js';
import { deliverNext } from './deliver.js';
const config = readConfig();
const pool = createPool(config.DATABASE_URL);
const sender: Sender =
  config.TELEGRAM_MODE === 'live'
    ? new TelegramSender(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID)
    : {
        send: async (_text) => {
          log('notifier', 'dry_run_delivery');
        },
      };
await runService({
  name: 'notifier',
  port: config.NOTIFIER_PORT,
  intervalMs: config.WORKER_INTERVAL_MS,
  pool,
  tick: async (signal) => {
    for (let i = 0; i < 25 && !signal.aborted; i++) {
      if (!(await deliverNext(pool, sender, config.PREFER_RUSSIAN))) break;
    }
  },
});
