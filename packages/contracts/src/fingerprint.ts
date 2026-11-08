import { createHash } from 'node:crypto';
import type { Post } from './index.js';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const normalizeContent = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#[\p{L}\d_]+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export function contentFingerprint(post: Post): string {
  return hash(
    JSON.stringify([
      post.title ?? '',
      post.text.normalize('NFKC').replace(/\s+/g, ' ').trim(),
      post.location ?? '',
      post.textIncomplete ?? false,
      post.imageUrls?.map((value) => {
        const url = new URL(value);
        return url.origin + url.pathname;
      }) ?? [],
    ]),
  );
}
export function sourceAlias(post: Post): string {
  return `source:${post.id}:${post.kind === 'job' ? 'job' : normalizeContent(post.title ?? '')}`;
}
/** Merge only hard evidence: a job-specific application link or identical long text. */
export function vacancyAliases(post: Post): string[] {
  const aliases = [sourceAlias(post)];
  const jobId =
    post.kind === 'job' ? post.id.match(/jobPosting:(\d+)/)?.[1] : undefined;
  if (jobId) aliases.push(`linkedin-job:${jobId}`);
  for (const raw of post.text.match(/https?:\/\/[^\s<>]+/g) ?? []) {
    try {
      const url = new URL(raw.replace(/[).,;]+$/, ''));
      const linkedInId =
        url.hostname === 'linkedin.com' ||
        url.hostname.endsWith('.linkedin.com')
          ? url.pathname.match(/\/jobs\/view\/(\d+)/)?.[1]
          : undefined;
      if (linkedInId) {
        aliases.push(`linkedin-job:${linkedInId}`);
        continue;
      }
      // A company home page or shared short URL is not a unique vacancy identifier.
      if (
        !/\/(?:jobs?|positions?|vacancies|careers)\/[^/?#]*\d{3}[^/?#]*(?:\/|$)/i.test(
          url.pathname,
        ) ||
        url.hostname === 'lnkd.in'
      )
        continue;
      for (const key of [...url.searchParams.keys()])
        if (/^(?:utm_|trk|tracking)/i.test(key)) url.searchParams.delete(key);
      url.hash = '';
      aliases.push(`application:${url.href}`);
    } catch {
      /* Ignore prose that resembles a URL. */
    }
  }
  const text = normalizeContent(post.text);
  if (text.length >= 180) aliases.push(`text:${hash(text)}`);
  return [...new Set(aliases)].sort();
}
