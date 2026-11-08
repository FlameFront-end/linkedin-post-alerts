import { decodeFeedPage, feedContinuation } from '../linkedin/feed-pages.js';
import { decodeSearchHtml } from '../linkedin/search-html.js';
import type { PostSource } from './source.js';
import type { Post } from '../../../../packages/contracts/src/index.js';
import {
  LinkedInClient,
  checkedUrl,
  feedPagePath,
} from '../linkedin/client.js';
import { decodePosts } from '../linkedin/decode.js';
import type { Settings, Session } from '../linkedin/settings.js';
import {
  GlobalPostSearch,
  type KnownPosts,
} from '../linkedin/global-search.js';
import { LinkedInError } from '../linkedin/errors.js';

const HEALTHY = new Set(['ok', 'partial', 'budget']);

export class LinkedInSource implements PostSource {
  readonly name = 'linkedin';
  private readonly client: LinkedInClient;
  private readonly globalSearch: GlobalPostSearch;
  private disabled = new Map<number, number>();
  private cycle = 0;
  reports: {
    index: number;
    kind: 'author' | 'keyword' | 'feed';
    status: string;
    posts: number;
  }[] = [];
  onPage?: (report: {
    index: number;
    kind: string;
    elements: number;
    posts: number;
    fresh: number;
    skippedNoText: number;
    skippedKnown?: number;
  }) => void;
  private pausedUntil = 0;
  private halted: LinkedInError | undefined;
  constructor(
    private readonly settings: Settings & { session: Session },
    request: typeof fetch = fetch,
    known?: KnownPosts,
  ) {
    this.client = new LinkedInClient(
      settings.session,
      settings.requestIntervalMs,
      request,
    );
    this.globalSearch = new GlobalPostSearch(this.client, settings, known);
    if (settings.searchPathTemplate) checkedUrl(settings.searchPathTemplate);
    checkedUrl(settings.postPathTemplate);
  }
  isReady() {
    return !this.halted && Date.now() >= this.pausedUntil && !this.failing();
  }
  /** Every attempted target failed: collection is effectively down. */
  failing() {
    const attempted = this.reports.filter(
      (report) => report.status !== 'skipped',
    );
    return (
      attempted.length > 0 &&
      attempted.every((report) => !HEALTHY.has(report.status))
    );
  }
  get requestsUsed() {
    return this.client.requestsUsed;
  }
  get haltedCode() {
    return this.halted?.code;
  }
  get pausedUntilMs() {
    return this.pausedUntil;
  }
  async *fetchBatches(signal?: AbortSignal): AsyncGenerator<Post[]> {
    if (this.halted) throw this.halted;
    if (Date.now() < this.pausedUntil) throw new LinkedInError('cooldown');
    const targets = [
      ...this.settings.authorUrns.map((urn) => ({
        kind: 'author' as const,
        path: (start: number, token?: string) => {
          const params = new URLSearchParams({
            count: String(this.settings.pageSize),
            start: String(start),
            q: 'memberShareFeed',
            moduleKey: 'member-shares:phone',
            includeLongTermHistory: 'true',
            profileUrn: urn,
          });
          if (token) params.set('paginationToken', token);
          return '/voyager/api/identity/profileUpdatesV2?' + params;
        },
      })),
      ...this.settings.keywords.map((keyword) => ({
        kind: 'keyword' as const,
        keyword,
      })),
      ...(this.settings.personalFeed ? [{ kind: 'feed' as const }] : []),
    ];
    this.reports = [];
    this.client.beginCycle(this.settings.maxRequestsPerCycle);
    const seen = new Set<string>();
    const globalSearch = this.globalSearch;
    // Refresh the feed first, then rotate the remaining targets for fairness.
    const indexed = targets.map((target, index) => [index, target] as const);
    const feed = indexed.find(([, target]) => target.kind === 'feed');
    const other = indexed.filter(([, target]) => target.kind !== 'feed');
    const offset = other.length ? this.cycle++ % other.length : 0;
    const order = [
      ...(feed ? [feed] : []),
      ...other.slice(offset),
      ...other.slice(0, offset),
    ];
    let budgetSpent = false;
    for (const [index, target] of order) {
      if (budgetSpent) {
        this.reports.push({
          index,
          kind: target.kind,
          status: 'skipped',
          posts: 0,
        });
        continue;
      }
      if ((this.disabled.get(index) ?? 0) > Date.now()) {
        this.reports.push({
          index,
          kind: target.kind,
          status: 'disabled',
          posts: 0,
        });
        continue;
      }
      let token: string | undefined;
      let posts = 0;
      try {
        if (target.kind === 'feed') {
          const html = await this.client.get(feedPagePath, signal);
          if (typeof html !== 'string')
            throw new LinkedInError('response_format');
          let discovered = decodeSearchHtml(html, new Date(), 'feed');
          let continuation = feedContinuation(html, true);
          for (
            let page = 0;
            page <= this.settings.personalFeedLoadMore;
            page++
          ) {
            const fresh = discovered.filter((post) => {
              if (
                seen.has(post.id) ||
                Date.parse(post.publishedAt) <
                  Date.now() - this.settings.maxAgeHours * 3600000
              )
                return false;
              seen.add(post.id);
              return true;
            });
            posts += fresh.length;
            this.onPage?.({
              index,
              kind: 'feed',
              elements: discovered.length,
              posts: discovered.length,
              fresh: fresh.length,
              skippedNoText: 0,
              skippedKnown: 0,
            });
            yield fresh;
            if (!continuation || page === this.settings.personalFeedLoadMore)
              break;
            const response = await this.client.nextFeedPage(
              continuation.body,
              signal,
            );
            discovered = decodeFeedPage(response);
            continuation = feedContinuation(
              response,
              false,
              continuation.start,
            );
          }
          this.reports.push({
            index,
            kind: 'feed',
            status: 'ok',
            posts,
          });
          continue;
        }
        if (target.kind === 'keyword') {
          let detailFailures = 0;
          for await (const batch of globalSearch.pages(
            target.keyword,
            seen,
            signal,
          )) {
            const fresh = batch.posts.filter(
              (post) =>
                Date.parse(post.publishedAt) >=
                Date.now() - this.settings.maxAgeHours * 3600000,
            );
            posts += fresh.length;
            detailFailures += batch.failedDetails;
            this.onPage?.({
              index,
              kind: target.kind,
              elements: batch.discovered,
              posts: batch.posts.length,
              fresh: fresh.length,
              skippedNoText: 0,
              skippedKnown: batch.skippedKnown,
            });
            yield fresh;
          }
          this.reports.push({
            index,
            kind: target.kind,
            status: detailFailures ? 'partial' : 'ok',
            posts,
          });
          continue;
        }
        for (let page = 0; page < this.settings.maxPages; page++) {
          signal?.throwIfAborted();
          const start = page * this.settings.pageSize;
          const decoded = decodePosts(
            await this.client.get(target.path(start, token), signal),
          );
          const cutoff = Date.now() - this.settings.maxAgeHours * 3600000;
          const fresh = decoded.posts.filter(
            (post) => Date.parse(post.publishedAt) >= cutoff,
          );
          posts += fresh.length;
          this.onPage?.({
            index,
            kind: target.kind,
            elements: decoded.count,
            posts: decoded.posts.length,
            fresh: fresh.length,
            skippedNoText: decoded.skippedNoText,
          });
          yield fresh;
          if (
            decoded.count === 0 ||
            (decoded.total !== undefined &&
              start + decoded.count >= decoded.total)
          )
            break;
          // Author pagination requires a server-issued token. Never guess page 2.
          if (target.kind === 'author') {
            if (!decoded.paginationToken || decoded.paginationToken === token)
              break;
            token = decoded.paginationToken;
          }
        }
        this.reports.push({ index, kind: target.kind, status: 'ok', posts });
      } catch (error) {
        // Abort, database and programming errors are not target failures.
        if (signal?.aborted || !(error instanceof LinkedInError)) throw error;
        const failure = error;
        if (failure.code === 'budget') {
          budgetSpent = true;
          this.reports.push({
            index,
            kind: target.kind,
            status: 'budget',
            posts,
          });
          continue;
        }
        this.reports.push({
          index,
          kind: target.kind,
          status: failure.code,
          posts,
        });
        if (failure.code === 'auth_required') {
          this.halted = failure;
          throw failure;
        }
        if (failure.code === 'rate_limited') {
          this.pausedUntil = Date.now() + failure.retryAfterSeconds * 1000;
          throw failure;
        }
        if (failure.code === 'response_format' && target.kind !== 'feed')
          this.disabled.set(index, Date.now() + 600000);
        // A malformed or unavailable target must not starve healthy targets.
      }
    }
  }

  async fetchPosts(signal?: AbortSignal): Promise<Post[]> {
    const posts: Post[] = [];
    for await (const batch of this.fetchBatches(signal)) posts.push(...batch);
    return posts;
  }
}
