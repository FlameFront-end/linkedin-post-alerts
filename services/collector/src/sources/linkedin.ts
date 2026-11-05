import type { PostSource } from './source.js';
import type { Post } from '../../../../packages/contracts/src/index.js';
import { LinkedInClient, checkedUrl } from '../linkedin/client.js';
import { decodePosts } from '../linkedin/decode.js';
import type { Settings, Session } from '../linkedin/settings.js';
import { LinkedInError } from '../linkedin/errors.js';

const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (v) => `%${v.charCodeAt(0).toString(16).toUpperCase()}`,
  );
export class LinkedInSource implements PostSource {
  readonly name = 'linkedin';
  private readonly client: LinkedInClient;
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
    if (settings.searchPathTemplate) checkedUrl(settings.searchPathTemplate);
  }
  async *fetchBatches(signal?: AbortSignal): AsyncGenerator<Post[]> {
    if (this.halted) throw this.halted;
    if (Date.now() < this.pausedUntil) throw new LinkedInError('cooldown');
    const targets = [
      ...this.settings.authorUrns.map(
        (urn) => (start: number) =>
          '/voyager/api/identity/profileUpdatesV2?' +
          new URLSearchParams({
            count: String(this.settings.pageSize),
            start: String(start),
            q: 'memberShareFeed',
            moduleKey: 'member-shares:phone',
            includeLongTermHistory: 'true',
            profileUrn: urn,
          }),
      ),
      ...this.settings.keywords.map(
        (keyword) => (start: number) =>
          this.settings
            .searchPathTemplate!.replaceAll('{keywords}', encode(keyword))
            .replaceAll('{start}', String(start))
            .replaceAll('{count}', String(this.settings.pageSize)),
      ),
    ];
    try {
      for (const target of targets) {
        for (let page = 0; page < this.settings.maxPages; page++) {
          signal?.throwIfAborted();
          const start = page * this.settings.pageSize;
          const decoded = decodePosts(
            await this.client.get(target(start), signal),
          );
          const cutoff = Date.now() - this.settings.maxAgeHours * 3600000;
          yield decoded.posts.filter(
            (post) => Date.parse(post.publishedAt) >= cutoff,
          );
          if (
            decoded.count === 0 ||
            (decoded.total !== undefined &&
              start + decoded.count >= decoded.total)
          )
            break;
        }
      }
    } catch (error) {
      if (error instanceof LinkedInError) {
        if (error.code === 'auth_required' || error.code === 'response_format')
          this.halted = error;
        this.pausedUntil = Date.now() + error.retryAfterSeconds * 1000;
      }
      throw error;
    }
  }
  async fetchPosts(signal?: AbortSignal): Promise<Post[]> {
    const posts: Post[] = [];
    for await (const batch of this.fetchBatches(signal)) posts.push(...batch);
    return posts;
  }
}
