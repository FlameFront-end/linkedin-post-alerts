import { decodeHtmlPage } from './search-html.js';
import { decodeFeedPage } from './feed-pages.js';
import {
  continuation,
  nextSearchLink,
  searchPaginationState,
  type SearchPaginationState,
} from './pagination.js';
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
  'search_restricted',
  'source_blocked',
  'request_limit',
  'protection_pause',
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
    coverageLimited?: boolean;
    skippedNoText?: number;
    pagination?: SearchPaginationState;
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
        yield* this.htmlPages(body, path, seen, signal);
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
  private async *htmlPages(
    first: string,
    initialPath: string,
    seen: Set<string>,
    signal?: AbortSignal,
  ) {
    let body = first;
    let stream = false;
    let after = -1;
    let hydrated = 0;
    const visited = new Set<string>([initialPath]);
    for (let page = 0; page < this.settings.maxPages; page++) {
      const decoded = stream
        ? { posts: decodeFeedPage(body), cards: 0, skippedNoText: 0 }
        : decodeHtmlPage(body);
      const posts: Post[] = [];
      let failedDetails = 0;
      for (const candidate of decoded.posts) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        let post = candidate;
        if (
          post.textIncomplete &&
          hydrated < this.settings.maxDetailsPerQuery &&
          !this.settings.postPathTemplate.includes('{slug}')
        ) {
          hydrated++;
          try {
            const full = decodeDetails(
              await this.client.get(
                this.settings.postPathTemplate.replaceAll(
                  '{urn}',
                  encodeValue(post.id),
                ),
                signal,
              ),
              { urn: post.id, url: post.url },
            );
            if (full) post = { ...full, id: post.id, url: post.url };
          } catch (error) {
            if (
              signal?.aborted ||
              !(error instanceof LinkedInError) ||
              FATAL.has(error.code)
            )
              throw error;
            failedDetails++;
          }
        }
        posts.push(post);
      }
      const next = continuation(body, !stream, 'search', after);
      const link = !stream ? nextSearchLink(body) : undefined;
      const key = next?.body ?? link;
      const pagination = stream
        ? key
          ? ('continuation' as const)
          : ('unknown' as const)
        : searchPaginationState(body, !!key);
      const coverageLimited =
        decoded.posts.length > 0 &&
        pagination === 'unknown' &&
        this.settings.maxPages > 1;
      yield {
        posts,
        discovered: decoded.cards || decoded.posts.length,
        failedDetails,
        skippedKnown: 0,
        skippedNoText: decoded.skippedNoText,
        coverageLimited,
        pagination,
      };
      if (!key || visited.has(key) || page + 1 >= this.settings.maxPages) break;
      visited.add(key);
      if (next) {
        body = await this.client.nextPage(next, signal);
        after = next.start;
        stream = true;
      } else {
        body = String(await this.client.get(link!, signal));
        stream = false;
      }
    }
  }
  private remember(urn: string, post: Post | undefined) {
    this.cache.delete(urn);
    this.cache.set(urn, { post, expires: Date.now() + CACHE_TTL_MS });
    if (this.cache.size > CACHE_LIMIT)
      this.cache.delete(this.cache.keys().next().value!);
  }
}
