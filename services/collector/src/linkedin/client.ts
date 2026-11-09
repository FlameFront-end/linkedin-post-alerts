import {
  log,
  errorFields,
  failureLevel,
  withLogContext,
  newTraceId,
} from '../../../../packages/runtime/src/logger.js';
import { load } from 'cheerio';
import type { ScopedProtection } from './protection.js';
import { feedPaginationPath } from './feed-pages.js';
import { validPager, type Continuation } from './pagination.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Session } from './settings.js';
import { LinkedInError } from './errors.js';

const isJobsPath = (path: string) =>
  path === '/jobs-guest/jobs/api/seeMoreJobPostings/search' ||
  /^\/jobs-guest\/jobs\/api\/jobPosting\/\d{6,15}$/.test(path);
export const feedPagePath = '/feed/foryou/';
export const searchPagePath = '/search/results/content/';

export function checkedUrl(path: string) {
  const url = new URL(path, 'https://www.linkedin.com');
  if (
    (!path.startsWith('/voyager/api/') &&
      !path.startsWith(searchPagePath + '?') &&
      path !== feedPagePath &&
      !isJobsPath(url.pathname)) ||
    url.origin !== 'https://www.linkedin.com' ||
    (!url.pathname.startsWith('/voyager/api/') &&
      url.pathname !== searchPagePath &&
      url.pathname !== feedPagePath &&
      !isJobsPath(url.pathname)) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new LinkedInError('configuration');
  return url;
}
export class RequestGate {
  private next = 0;
  private blocked?: LinkedInError;
  private pause = 0;
  async wait(intervalMs: number, signal?: AbortSignal) {
    if (this.blocked) throw this.blocked;
    if (Date.now() < this.pause) throw new LinkedInError('cooldown');
    const at = Math.max(Date.now(), this.next);
    this.next = at + intervalMs;
    if (at > Date.now())
      await sleep(at - Date.now(), undefined, signal ? { signal } : undefined);
    if (this.blocked) throw this.blocked;
    if (Date.now() < this.pause) throw new LinkedInError('cooldown');
  }
  fail(error: LinkedInError) {
    if (error.code === 'auth_required') this.blocked = error;
    if (error.code === 'rate_limited')
      this.pause = Math.max(
        this.pause,
        Date.now() + error.retryAfterSeconds * 1000,
      );
  }
}
export class LinkedInClient {
  private nextRequestAt = 0;
  private used = 0;
  private limit = Number.POSITIVE_INFINITY;
  constructor(
    private readonly session: Session,
    private readonly intervalMs: number,
    private readonly request: typeof fetch = fetch,
    private readonly gate?: RequestGate,
    private readonly protection?: ScopedProtection,
  ) {
    if (request === fetch && !protection)
      throw new LinkedInError(
        'configuration',
        60,
        'durable_protection_required',
      );
  }
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
  async nextPage(page: Continuation, signal?: AbortSignal): Promise<string> {
    if (!validPager(page.pagerId)) throw new LinkedInError('configuration');
    const result = await this.fetchResponse(
      new URL(
        '/flagship-web/rsc-action/actions/pagination?sduiid=' +
          encodeURIComponent(page.pagerId),
        'https://www.linkedin.com',
      ),
      signal,
      page.body,
    );
    if (typeof result !== 'string') throw new LinkedInError('response_format');
    return result;
  }
  private async fetchResponse(
    url: URL,
    signal?: AbortSignal,
    body?: string,
  ): Promise<unknown> {
    const started = Date.now();
    const endpoint = isJobsPath(url.pathname)
      ? url.pathname.endsWith('/search')
        ? 'jobs_search'
        : 'job_details'
      : url.pathname === feedPagePath
        ? 'feed'
        : url.pathname === searchPagePath
          ? 'post_search'
          : body !== undefined
            ? 'pagination'
            : 'voyager';
    return withLogContext({ requestId: newTraceId(), endpoint }, async () => {
      try {
        if (this.used >= this.limit) throw new LinkedInError('budget');
        const result = this.protection
          ? await this.protection.run(
              () => this.performResponse(url, signal, body),
              signal,
            )
          : await this.performResponse(url, signal, body);
        log('collector', 'request_finished', {
          durationMs: Date.now() - started,
          requestsUsed: this.used,
        });
        return result;
      } catch (error) {
        log(
          'collector',
          'request_failed',
          {
            durationMs: Date.now() - started,
            requestsUsed: this.used,
            ...errorFields(error),
          },
          failureLevel(error instanceof LinkedInError ? error.code : 'network'),
        );
        throw error;
      }
    });
  }

  private async performResponse(
    url: URL,
    signal?: AbortSignal,
    body?: string,
  ): Promise<unknown> {
    const html =
      url.pathname === searchPagePath ||
      url.pathname === feedPagePath ||
      isJobsPath(url.pathname);
    if (this.used >= this.limit) throw new LinkedInError('budget');
    this.used++;
    const delay = Math.max(0, this.nextRequestAt - Date.now());
    if (delay) await sleep(delay, undefined, signal ? { signal } : undefined);
    await this.gate?.wait(this.intervalMs, signal);
    const timeout = AbortSignal.timeout(15000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    this.nextRequestAt = Date.now() + this.intervalMs;
    try {
      log('collector', 'http_request_started', {
        method: body === undefined ? 'GET' : 'POST',
        requestsUsed: this.used,
      });
      const sentAt = Date.now();
      const response = await this.request(url, {
        redirect: 'manual',
        ...(url.pathname === feedPagePath ? { cache: 'no-store' } : {}),
        ...(body === undefined ? {} : { method: 'POST', body }),
        signal: combined,
        headers: {
          ...(this.session.userAgent
            ? { 'user-agent': this.session.userAgent }
            : {}),
          ...(isJobsPath(url.pathname)
            ? {}
            : {
                cookie: `li_at=${this.session.liAt}; JSESSIONID=${this.session.jsessionId}`,
                'csrf-token':
                  this.session.csrfToken ??
                  this.session.jsessionId.replace(/^"|"$/g, ''),
              }),
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
      log('collector', 'http_response', {
        httpStatus: response.status,
        durationMs: Date.now() - sentAt,
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
            ? Math.max(60, Math.min(604800, Math.ceil(seconds)))
            : 300,
          Number.isFinite(seconds) && seconds > 604800
            ? 'retry_after_exceeds_week'
            : undefined,
        );
      }
      if ([404, 410].includes(response.status))
        throw new LinkedInError('item_unavailable');
      if (!response.ok) throw new LinkedInError('http_error');
      const contentType = response.headers.get('content-type') ?? '';
      const returnedHtml = contentType.includes('text/html');
      const expectedType =
        body !== undefined
          ? 'application/octet-stream'
          : html
            ? 'text/html'
            : 'json';
      if (!contentType.includes(expectedType) && !returnedHtml)
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
      log('collector', 'response_read', {
        bytes: size,
        durationMs: Date.now() - sentAt,
      });
      const content = Buffer.concat(chunks).toString('utf8');
      if (html || body !== undefined || returnedHtml) {
        const page = load(content);
        page('script,style').remove();
        const banner = page('[role="alert"], [role="dialog"]').text();
        const hasCards =
          page(
            '[componentkey^="update-card-focus"], [data-urn^="urn:li:activity:"]',
          ).length > 0;
        const visible = (
          banner || (hasCards ? '' : page('body').text())
        ).replace(/\s+/g, ' ');
        if (
          /необычн.{0,40}поисков|поисковые действия.{0,100}приостановлен|unusual search traffic|search activities.{0,100}(?:suspended|restricted)|search(?:ing)?.{0,40}temporarily restricted/i.test(
            visible,
          )
        )
          throw new LinkedInError(
            'search_restricted',
            3600,
            'search_suspended',
          );
        if (
          /Наши системы обнаружили необычн|we(?:'ve| have) detected unusual|unusual activity from your|security verification required|captcha|security challenge/i.test(
            visible,
          )
        )
          throw new LinkedInError(
            'auth_required',
            3600,
            'verification_required',
          );
      }
      if (returnedHtml && !html && body === undefined)
        throw new LinkedInError('response_format');
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
      if (error instanceof LinkedInError) {
        this.gate?.fail(error);
        throw error;
      }
      throw new LinkedInError('network');
    }
  }
}
