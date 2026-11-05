import type { PostSource } from './source.js';
import type { Post } from '../../../../packages/contracts/src/index.js';

// Boundary for future direct HTTP implementation; no browser dependency.
// Fail loudly until real post search and author feeds are verified separately.
export class LinkedInSource implements PostSource {
  readonly name = 'linkedin';
  async fetchPosts(): Promise<Post[]> {
    throw new Error(
      'LinkedIn adapter is not configured. See docs/LINKEDIN_ADAPTER.md',
    );
  }
}
