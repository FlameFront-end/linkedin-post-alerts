import { createPool } from '../packages/runtime/src/db.js';
import { replayDead } from '../packages/queue/src/index.js';
const [kind, id, flag] = process.argv.slice(2);
if (
  (kind !== 'post' && kind !== 'notification' && kind !== 'alert') ||
  !id ||
  !/^\d+$/.test(id) ||
  (flag && flag !== '--apply')
)
  throw new Error(
    'Usage: queue:replay -- post|notification|alert ID [--apply]',
  );
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const pool = createPool(process.env.DATABASE_URL);
try {
  if (flag === '--apply')
    console.log(JSON.stringify({ replayed: await replayDead(pool, kind, id) }));
  else {
    const result = await pool.query(
      "SELECT id,kind,status FROM queue.jobs WHERE id=$1 AND kind=$2 AND status='dead'",
      [id, kind],
    );
    console.log(JSON.stringify({ preview: true, jobs: result.rows }));
  }
} finally {
  await pool.end();
}
