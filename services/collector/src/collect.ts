import { postSchema } from '../../../packages/contracts/src/index.js';
import { enqueue } from '../../../packages/queue/src/index.js';
import type { Database } from '../../../packages/runtime/src/db.js';
import type { PostSource } from './sources/source.js';
export async function collect(
  source: PostSource,
  db: Database,
  signal?: AbortSignal,
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
      await enqueue(db, 'post', post.id, post);
      count++;
    }
  }
  return count;
}
