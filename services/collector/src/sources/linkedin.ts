import type { PostSource } from './source.js';
import type { Post } from '../../../../packages/contracts/src/index.js';
import { LinkedInClient, checkedUrl } from '../linkedin/client.js';
import { decodePosts } from '../linkedin/decode.js';
import type { Settings, Session } from '../linkedin/settings.js';
import { GlobalPostSearch } from '../linkedin/global-search.js';
import { LinkedInError } from '../linkedin/errors.js';

export class LinkedInSource implements PostSource {
  readonly name = 'linkedin';
  private readonly client: LinkedInClient;
  private readonly globalSearch: GlobalPostSearch;
  private disabled = new Set<number>();
  reports: {
    index: number;
    kind: 'author' | 'keyword';
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
  }) => void;
  private pausedUntil = 0;
  private halted: LinkedInError | undefined;
  constructor(
    private readonly settings: Settings & { session: Session },
    request: typeof fetch = fetch,
  ) {
    this.client = new LinkedInClient(
      settings.session,
      settings.requestIntervalMs,
      request,
    );
    this.globalSearch = new GlobalPostSearch(this.client, settings);
    if (settings.searchPathTemplate) checkedUrl(settings.searchPathTemplate);
    checkedUrl(settings.postPathTemplate);
  }
  isReady() {
    return (
      !this.halted &&
      Date.now() >= this.pausedUntil &&
      (!this.reports.length ||
        this.reports.some((report) => report.status === 'ok'))
    );
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
    ];
    this.reports = [];
    const seen = new Set<string>();
    const globalSearch = this.globalSearch;
    for (const [index, target] of targets.entries()) {
      if (this.disabled.has(index)) {
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
        if (signal?.aborted) throw error;
        const failure =
          error instanceof LinkedInError ? error : new LinkedInError('network');
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
        if (failure.code === 'response_format') this.disabled.add(index);
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
