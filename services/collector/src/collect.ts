import { log } from '../../../packages/runtime/src/logger.js';
import { contentFingerprint } from '../../../packages/contracts/src/fingerprint.js';
import { postSchema } from '../../../packages/contracts/src/index.js';
import type { Database } from '../../../packages/runtime/src/db.js';
import type { PostSource } from './sources/source.js';
export async function collect(
  source: PostSource,
  db: Database,
  signal?: AbortSignal,
  onCount?: (count: number) => void,
) {
  const batches = source.fetchBatches
    ? source.fetchBatches(signal)
    : (async function* () {
        yield await source.fetchPosts(signal);
      })();
  let count = 0;
  for await (const posts of batches) {
    for (const value of posts) {
      signal?.throwIfAborted();
      const post = postSchema.parse(value);
      const fingerprint = contentFingerprint(post);
      const result = await db.query(
        `WITH observed AS (
        INSERT INTO processing.observations(id,fingerprint,observed_at) VALUES($1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,observed_at=excluded.observed_at,last_seen_at=now()
        WHERE processing.observations.observed_at <= excluded.observed_at RETURNING id
      ) INSERT INTO queue.jobs(kind,dedupe_key,payload)
        SELECT 'post',$4,$5::jsonb FROM observed
        ON CONFLICT(kind,dedupe_key) DO NOTHING RETURNING id`,
        [
          post.id,
          fingerprint,
          post.firstSeenAt,
          `${post.id}:${fingerprint}`,
          JSON.stringify(post),
        ],
      );
      log('collector', 'post_observed', {
        source: source.name,
        postId: post.id,
        revision: fingerprint.slice(0, 16),
        queued: !!result.rowCount,
        chars: post.text.length,
        images: post.imageUrls?.length ?? 0,
        incomplete: post.textIncomplete ?? false,
      });
      count += result.rowCount ?? 0;
      onCount?.(count);
    }
  }
  return count;
}
