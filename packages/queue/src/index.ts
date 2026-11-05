import { randomUUID } from 'node:crypto';
import type { Database } from '../../runtime/src/db.js';
import type { JobKind } from '../../contracts/src/index.js';

export interface Job {
  id: string;
  payload: unknown;
  attempts: number;
  lock_token: string;
}
export async function enqueue(
  db: Database,
  kind: JobKind,
  key: string,
  payload: unknown,
) {
  await db.query(
    `INSERT INTO queue.jobs(kind,dedupe_key,payload) VALUES($1,$2,$3) ON CONFLICT(kind,dedupe_key) DO NOTHING`,
    [kind, key, JSON.stringify(payload)],
  );
}
export async function claim(
  db: Database,
  kind: JobKind,
): Promise<Job | undefined> {
  // Recover exhausted jobs whose worker died during the final attempt.
  await db.query(
    `UPDATE queue.jobs SET status='dead', lock_token=NULL, locked_until=NULL, last_error='lease_exhausted'
    WHERE kind=$1 AND status='running' AND locked_until < now() AND attempts >= max_attempts`,
    [kind],
  );
  const result = await db.query<Job>(
    `WITH candidate AS (
    SELECT id FROM queue.jobs WHERE kind=$1 AND attempts < max_attempts AND
    ((status='pending' AND available_at <= now()) OR (status='running' AND locked_until < now()))
    ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE queue.jobs j SET status='running', attempts=j.attempts+1,
    locked_until=now()+interval '2 minutes', lock_token=$2
    FROM candidate c WHERE j.id=c.id RETURNING j.id,j.payload,j.attempts,j.lock_token`,
    [kind, randomUUID()],
  );
  return result.rows[0];
}
export async function complete(db: Database, job: Job) {
  const result = await db.query(
    `UPDATE queue.jobs SET status='done', completed_at=now(), locked_until=NULL, lock_token=NULL
    WHERE id=$1 AND lock_token=$2 AND status='running' AND locked_until > now()`,
    [job.id, job.lock_token],
  );
  if (result.rowCount !== 1) throw new Error('Job lease lost');
}
export async function fail(
  db: Database,
  job: Job,
  options: { permanent?: boolean; delaySeconds?: number } = {},
) {
  const delay = Math.max(
    1,
    Math.min(86400, options.delaySeconds ?? 2 ** job.attempts),
  );
  await db.query(
    `UPDATE queue.jobs SET status=CASE WHEN $3 OR attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
    available_at=now()+make_interval(secs => $4), locked_until=NULL, lock_token=NULL,
    last_error=CASE WHEN $3 THEN 'permanent_failure' ELSE 'transient_failure' END
    WHERE id=$1 AND lock_token=$2 AND status='running'`,
    [job.id, job.lock_token, options.permanent ?? false, delay],
  );
}

// Configuration failures do not consume the per-message delivery budget.
export async function release(db: Database, job: Job) {
  await db.query(
    `UPDATE queue.jobs SET status='pending', attempts=GREATEST(0,attempts-1), available_at=now(),
    lock_token=NULL, locked_until=NULL, last_error='delivery_blocked'
    WHERE id=$1 AND lock_token=$2 AND status='running'`,
    [job.id, job.lock_token],
  );
}
export async function replayDead(db: Database, kind: JobKind, id: string) {
  const result = await db.query(
    `UPDATE queue.jobs SET status='pending', attempts=0, available_at=now(), completed_at=NULL,
    lock_token=NULL, locked_until=NULL, last_error=NULL WHERE id=$1 AND kind=$2 AND status='dead'`,
    [id, kind],
  );
  return result.rowCount === 1;
}
