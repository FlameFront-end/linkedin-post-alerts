import { setTimeout as sleep } from 'node:timers/promises';
import type { Session } from './settings.js';
import { LinkedInError } from './errors.js';

export function checkedUrl(path: string) {
  const url = new URL(path, 'https://www.linkedin.com');
  if (
    !path.startsWith('/voyager/api/') ||
    url.origin !== 'https://www.linkedin.com' ||
    !url.pathname.startsWith('/voyager/api/') ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new LinkedInError('configuration');
  return url;
}
export class LinkedInClient {
  private nextRequestAt = 0;
  constructor(
    private readonly session: Session,
    private readonly intervalMs: number,
    private readonly request: typeof fetch = fetch,
  ) {}
  async get(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = checkedUrl(path);
    const delay = Math.max(0, this.nextRequestAt - Date.now());
    if (delay) await sleep(delay, undefined, signal ? { signal } : undefined);
    const timeout = AbortSignal.timeout(15000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    this.nextRequestAt = Date.now() + this.intervalMs;
    try {
      const response = await this.request(url, {
        redirect: 'manual',
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
          accept: 'application/vnd.linkedin.normalized+json+2.1',
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
      if (!response.headers.get('content-type')?.includes('json'))
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
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new LinkedInError('response_too_large');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      try {
        const data: unknown = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        );
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
