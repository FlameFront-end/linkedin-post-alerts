import { decodeSearchHtml } from './search-html.js';
import type { Post } from '../../../../packages/contracts/src/index.js';
import { LinkedInClient } from './client.js';
import { decodeSearch } from './search.js';
import { decodeDetails } from './details.js';
import { encodeValue } from './graph.js';
import { LinkedInError } from './errors.js';
import type { Settings } from './settings.js';

/** Returns the subset of post URNs that were already collected (durable store). */
export type KnownPosts = (urns: string[]) => Promise<Set<string>>;

const CACHE_TTL_MS = 600_000;
const CACHE_LIMIT = 1000;
// Errors that concern the whole session or cycle, never a single post.
const FATAL = new Set([
  'auth_required',
  'rate_limited',
  'configuration',
  'budget',
]);

export class GlobalPostSearch {
  private readonly cache = new Map<
    string,
    { post: Post | undefined; expires: number }
  >();
  constructor(
    private readonly client: LinkedInClient,
    private readonly settings: Settings,
    private readonly known?: KnownPosts,
  ) {}
  async *pages(
    keyword: string,
    seen: Set<string>,
    signal?: AbortSignal,
  ): AsyncGenerator<{
    posts: Post[];
    discovered: number;
    failedDetails: number;
    skippedKnown: number;
  }> {
    let start = 0;
    let hydrated = 0;
    let decodedDetails = 0;
    let formatFailures = 0;
    for (let page = 0; page < this.settings.maxPages; page++) {
      signal?.throwIfAborted();
      const path = this.settings
        .searchPathTemplate!.replaceAll('{keywords}', encodeValue(keyword))
        .replaceAll('{start}', String(start))
        .replaceAll('{count}', String(this.settings.pageSize));
      const body = await this.client.get(path, signal);
      if (typeof body === 'string') {
        const posts = decodeSearchHtml(body).filter((post) => {
          if (seen.has(post.id)) return false;
          seen.add(post.id);
          return true;
        });
        yield {
          posts,
          discovered: posts.length,
          failedDetails: 0,
          skippedKnown: 0,
        };
        return;
      }
      const result = decodeSearch(body);
      const fresh = result.references.filter((ref) => !seen.has(ref.urn));
      // Durable dedupe before spending requests: already queued posts are not re-fetched.
      const alreadyKnown = this.known
        ? await this.known(fresh.map((ref) => ref.urn))
        : new Set<string>();
      const posts: Post[] = [];
      let failedDetails = 0;
      let skippedKnown = 0;
      for (const reference of fresh) {
        if (alreadyKnown.has(reference.urn)) {
          seen.add(reference.urn);
          skippedKnown++;
          continue;
        }
        const cached = this.cache.get(reference.urn);
        if (cached && cached.expires > Date.now()) {
          if (cached.post) posts.push(cached.post);
          seen.add(reference.urn);
          continue;
        }
        if (hydrated >= this.settings.maxDetailsPerQuery) break;
        if (
          this.settings.postPathTemplate.includes('{slug}') &&
          !reference.slug
        ) {
          failedDetails++;
          continue;
        }
        signal?.throwIfAborted();
        hydrated++;
        const detailPath = this.settings.postPathTemplate
          .replaceAll('{urn}', encodeValue(reference.urn))
          .replaceAll('{slug}', encodeValue(reference.slug ?? ''));
        try {
          const post = decodeDetails(
            await this.client.get(detailPath, signal),
            reference,
          );
          decodedDetails++;
          if (post) {
            posts.push(post);
            seen.add(post.id);
          }
          this.remember(reference.urn, post);
          seen.add(reference.urn);
        } catch (error) {
          if (
            signal?.aborted ||
            !(error instanceof LinkedInError) ||
            FATAL.has(error.code)
          )
            throw error;
          // One deleted, private or unusual post must not disable the whole query.
          failedDetails++;
          if (error.code === 'response_format') formatFailures++;
        }
      }
      // If no detail response can be decoded, the post request itself is wrong.
      if (formatFailures >= 3 && decodedDetails === 0)
        throw new LinkedInError('response_format', 60, 'detail_format');
      yield {
        posts,
        discovered: result.references.length,
        failedDetails,
        skippedKnown,
      };
      if (result.empty || hydrated >= this.settings.maxDetailsPerQuery) break;
      const next = result.nextStart ?? start + this.settings.pageSize;
      if (next <= start || (result.total !== undefined && next >= result.total))
        break;
      start = next;
    }
  }
  private remember(urn: string, post: Post | undefined) {
    this.cache.delete(urn);
    this.cache.set(urn, { post, expires: Date.now() + CACHE_TTL_MS });
    if (this.cache.size > CACHE_LIMIT)
      this.cache.delete(this.cache.keys().next().value!);
  }
}
