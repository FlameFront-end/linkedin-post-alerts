import type pg from 'pg';
import { postSchema } from '../../../packages/contracts/src/index.js';
import {
  claim,
  complete,
  enqueue,
  fail,
} from '../../../packages/queue/src/index.js';
import { transaction } from '../../../packages/runtime/src/db.js';
import { log } from '../../../packages/runtime/src/logger.js';
import { classify } from './classifier.js';

export async function processNext(pool: pg.Pool): Promise<boolean> {
  const job = await claim(pool, 'post');
  if (!job) return false;
  const parsed = postSchema.safeParse(job.payload);
  if (!parsed.success) {
    await fail(pool, job, { permanent: true });
    log('processor', 'invalid_job', { jobId: job.id });
    return true;
  }
  try {
    const post = parsed.data;
    const decision = classify(post.text);
    await transaction(pool, async (db) => {
      await db.query(
        `INSERT INTO processing.posts(id,payload,roles,russian,decision) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(id) DO NOTHING`,
        [
          post.id,
          JSON.stringify(post),
          decision.roles,
          decision.russian,
          decision.reason,
        ],
      );
      if (decision.roles.length)
        await enqueue(db, 'notification', post.id, {
          post,
          roles: decision.roles,
          russian: decision.russian,
        });
      await complete(db, job);
    });
    log('processor', 'post_processed', {
      jobId: job.id,
      decision: decision.reason,
    });
  } catch {
    await fail(pool, job);
    log('processor', 'job_retry', { jobId: job.id, attempt: job.attempts });
  }
  return true;
}
