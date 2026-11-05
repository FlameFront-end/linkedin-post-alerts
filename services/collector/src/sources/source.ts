import type { Post } from '../../../../packages/contracts/src/index.js';
export interface PostSource {
  readonly name: string;
  fetchPosts(signal?: AbortSignal): Promise<Post[]>;
  fetchBatches?(signal?: AbortSignal): AsyncIterable<Post[]>;
}
