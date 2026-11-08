import { createPool } from '../packages/runtime/src/db.js';
import { postSchema } from '../packages/contracts/src/index.js';
import {
  classifyPost,
  vacancyCandidates,
} from '../packages/contracts/src/classifier.js';
import { contentFingerprint } from '../packages/contracts/src/fingerprint.js';
import { enqueue } from '../packages/queue/src/index.js';
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some((arg) => arg !== '--apply'))
  throw Error('Usage: posts:audit [--apply]');
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
const pool = createPool(process.env.DATABASE_URL);
try {
  const result = await pool.query(
    'SELECT payload FROM processing.posts ORDER BY processed_at DESC LIMIT 5000',
  );
  const reasons: Record<string, number> = {};
  let eligible = 0,
    queued = 0,
    invalid = 0;
  for (const row of result.rows) {
    const parsed = postSchema.safeParse(row.payload);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const post = parsed.data;
    const decision = classifyPost(post);
    reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
    const candidates = vacancyCandidates(post);
    if (candidates.length) eligible++;
    const maxAge = post.kind === 'job' ? 168 : 24;
    if (
      apply &&
      Date.parse(post.publishedAt) >= Date.now() - maxAge * 3600000
    ) {
      if (
        await enqueue(
          pool,
          'post',
          `functional-2026-11-08:${post.id}:${contentFingerprint(post)}`,
          post,
        )
      )
        queued++;
    }
  }
  console.log(
    JSON.stringify({
      mode: apply ? 'apply' : 'preview',
      reviewed: result.rowCount,
      eligible,
      reasons,
      invalid,
      queued,
      accuracyMeasured: false,
    }),
  );
} finally {
  await pool.end();
}
