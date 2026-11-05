import type { Post } from '../../../../packages/contracts/src/index.js';
export interface PostSource {
  readonly name: string;
  fetchPosts(): Promise<Post[]>;
}
