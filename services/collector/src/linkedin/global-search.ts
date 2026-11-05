import type { Post } from '../../../../packages/contracts/src/index.js';
import { LinkedInClient } from './client.js';
import { decodeSearch } from './search.js';
import { decodeDetails } from './details.js';
import { encodeValue } from './graph.js';
import { LinkedInError } from './errors.js';
import type { Settings } from './settings.js';

export class GlobalPostSearch {
  private readonly cache = new Map<
    string,
    { post: Post | undefined; expires: number }
  >();
  constructor(
    private readonly client: LinkedInClient,
    private readonly settings: Settings,
  ) {}
  async *pages(
    keyword: string,
    seen: Set<string>,
    signal?: AbortSignal,
  ): AsyncGenerator<{
    posts: Post[];
    discovered: number;
    failedDetails: number;
  }> {
    let start = 0;
    let hydrated = 0;
    for (let page = 0; page < this.settings.maxPages; page++) {
      signal?.throwIfAborted();
      const path = this.settings
        .searchPathTemplate!.replaceAll('{keywords}', encodeValue(keyword))
        .replaceAll('{start}', String(start))
        .replaceAll('{count}', String(this.settings.pageSize));
      const result = decodeSearch(await this.client.get(path, signal));
      const posts: Post[] = [];
      let failedDetails = 0;
      for (const reference of result.references) {
        if (seen.has(reference.urn)) continue;
        const cached = this.cache.get(reference.urn);
        if (cached && cached.expires > Date.now()) {
          if (cached.post) posts.push(cached.post);
          seen.add(reference.urn);
          continue;
        }
        if (hydrated >= this.settings.maxDetailsPerQuery) break;
        signal?.throwIfAborted();
        hydrated++;
        const detailPath = this.settings.postPathTemplate
          .replaceAll('{urn}', encodeValue(reference.urn))
          .replaceAll('{slug}', encodeValue(reference.slug ?? ''));
        if (
          this.settings.postPathTemplate.includes('{slug}') &&
          !reference.slug
        ) {
          failedDetails++;
          continue;
        }
        try {
          const post = decodeDetails(
            await this.client.get(detailPath, signal),
            reference,
          );
          if (post) posts.push(post);
          this.cache.delete(reference.urn);
          this.cache.set(reference.urn, { post, expires: Date.now() + 600000 });
          if (this.cache.size > 1000)
            this.cache.delete(this.cache.keys().next().value!);
          seen.add(reference.urn);
        } catch (error) {
          if (
            signal?.aborted ||
            !(error instanceof LinkedInError) ||
            [
              'auth_required',
              'rate_limited',
              'response_format',
              'configuration',
            ].includes(error.code)
          )
            throw error;
          // Deleted or inaccessible post cannot starve the rest of the search page.
          failedDetails++;
        }
      }
      yield { posts, discovered: result.references.length, failedDetails };
      if (result.empty || hydrated >= this.settings.maxDetailsPerQuery) break;
      const next = result.nextStart ?? start + this.settings.pageSize;
      if (next <= start || (result.total !== undefined && next >= result.total))
        break;
      start = next;
    }
  }
}
