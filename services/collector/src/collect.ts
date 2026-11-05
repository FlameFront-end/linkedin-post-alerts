import { postSchema } from '../../../packages/contracts/src/index.js';
import { enqueue } from '../../../packages/queue/src/index.js';
import type { Database } from '../../../packages/runtime/src/db.js';
import type { PostSource } from './sources/source.js';

export async function collect(source: PostSource, db: Database) {
  const posts = await source.fetchPosts();
  for (const value of posts) {
    const post = postSchema.parse(value);
    // Stable post identity prevents repeats across polling cycles and restarts.
    // Edits are intentionally not requeued in this first version.
    await enqueue(db, 'post', post.id, post);
  }
  return posts.length;
}
