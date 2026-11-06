import { feedPaginationPath } from './feed-pages.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Session } from './settings.js';
import { LinkedInError } from './errors.js';

export const feedPagePath = '/feed/foryou/';
export const searchPagePath = '/search/results/content/';

export function checkedUrl(path: string) {
  const url = new URL(path, 'https://www.linkedin.com');
  if (
    (!path.startsWith('/voyager/api/') &&
      !path.startsWith(searchPagePath + '?') &&
      path !== feedPagePath) ||
    url.origin !== 'https://www.linkedin.com' ||
    (!url.pathname.startsWith('/voyager/api/') &&
      url.pathname !== searchPagePath &&
      url.pathname !== feedPagePath) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new LinkedInError('configuration');
  return url;
}
export class LinkedInClient {
  private nextRequestAt = 0;
  private used = 0;
  private limit = Number.POSITIVE_INFINITY;
  constructor(
    private readonly session: Session,
    private readonly intervalMs: number,
    private readonly request: typeof fetch = fetch,
  ) {}
  // Hard cap of HTTP requests per collection cycle, independent of query settings.
  beginCycle(limit: number) {
    this.used = 0;
    this.limit = limit;
  }
  get requestsUsed() {
    return this.used;
  }
  async get(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.fetchResponse(checkedUrl(path), signal);
  }
  async nextFeedPage(body: string, signal?: AbortSignal): Promise<string> {
    const result = await this.fetchResponse(
      new URL(feedPaginationPath, 'https://www.linkedin.com'),
      signal,
      body,
    );
    if (typeof result !== 'string') throw new LinkedInError('response_format');
    return result;
  }
  private async fetchResponse(
    url: URL,
    signal?: AbortSignal,
    body?: string,
  ): Promise<unknown> {
    const html =
      url.pathname === searchPagePath || url.pathname === feedPagePath;
    if (this.used >= this.limit) throw new LinkedInError('budget');
    this.used++;
    const delay = Math.max(0, this.nextRequestAt - Date.now());
    if (delay) await sleep(delay, undefined, signal ? { signal } : undefined);
    const timeout = AbortSignal.timeout(15000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    this.nextRequestAt = Date.now() + this.intervalMs;
    try {
      const response = await this.request(url, {
        redirect: 'manual',
        ...(url.pathname === feedPagePath ? { cache: 'no-store' } : {}),
        ...(body === undefined ? {} : { method: 'POST', body }),
        signal: combined,
        headers: {
          ...(this.session.userAgent
            ? { 'user-agent': this.session.userAgent }
            : {}),
          cookie: `li_at=${this.session.liAt}; JSESSIONID=${this.session.jsessionId}`,
          'csrf-token':
            this.session.csrfToken ??
            this.session.jsessionId.replace(/^"|"$/g, ''),
          'x-restli-protocol-version': '2.0.0',
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                origin: url.origin,
                referer: url.origin + feedPagePath,
              }),
          accept:
            body !== undefined
              ? '*/*'
              : html
                ? 'text/html'
                : 'application/vnd.linkedin.normalized+json+2.1',
        },
      });
      if ([301, 302, 303, 307, 308, 401, 403, 999].includes(response.status))
        throw new LinkedInError('auth_required');
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds =
          header && /^\d+$/.test(header)
            ? Number(header)
            : header
              ? (Date.parse(header) - Date.now()) / 1000
              : 300;
        throw new LinkedInError(
          'rate_limited',
          Number.isFinite(seconds)
            ? Math.max(60, Math.min(86400, Math.ceil(seconds)))
            : 300,
        );
      }
      if (!response.ok) throw new LinkedInError('http_error');
      if (
        !response.headers
          .get('content-type')
          ?.includes(
            body !== undefined
              ? 'application/octet-stream'
              : html
                ? 'text/html'
                : 'json',
          )
      )
        throw new LinkedInError('response_format');
      const reader = response.body?.getReader();
      if (!reader) throw new LinkedInError('response_format');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > (html || body !== undefined ? 10 : 4) * 1024 * 1024) {
            await reader.cancel();
            throw new LinkedInError('response_too_large');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const content = Buffer.concat(chunks).toString('utf8');
      if (html || body !== undefined) return content;
      try {
        const data: unknown = JSON.parse(content);
        if (
          typeof data === 'object' &&
          data !== null &&
          'errors' in data &&
          Array.isArray(data.errors) &&
          data.errors.length
        )
          throw new LinkedInError('response_format');
        return data;
      } catch {
        throw new LinkedInError('response_format');
      }
    } catch (error) {
      if (error instanceof LinkedInError) throw error;
      throw new LinkedInError('network');
    }
  }
}
