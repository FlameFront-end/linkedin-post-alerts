import {
  postSchema,
  type Post,
} from '../../../../packages/contracts/src/index.js';
import { log } from '../../../../packages/runtime/src/logger.js';
import { commentaryUrn, publishedFromUrn } from './post-identity.js';
import { LinkedInError } from './errors.js';
import { continuation } from './pagination.js';
import { renderText, streamRecords } from './stream.js';

export const feedPagerId = 'com.linkedin.sdui.pagers.feed.mainFeed';
export const feedPaginationPath =
  '/flagship-web/rsc-action/actions/pagination?sduiid=' + feedPagerId;
export const feedContinuation = (input: string, html: boolean, after = -1) =>
  continuation(input, html, 'feed', after);

export function decodeFeedPage(input: string, now = new Date()): Post[] {
  const records = streamRecords(input);
  const posts = new Map<string, Post>();
  const commentaryKeys = new Set<string>();
  let hasCards = false;
  let explicitEnd = false;

  // Flight records arrive in serialization order. Adjacent records can belong
  // to entirely different cards. Read commentary only from the props object
  // that carries its identity, resolving references inside its text subtree.
  const pending: unknown[] = [...records.values()];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
      continue;
    }
    const props = value as Record<string, unknown>;
    for (const child of Object.values(props)) pending.push(child);
    const key = props.componentKey;
    if (props.hasMore === false || props.hasNextPage === false)
      explicitEnd = true;
    if (typeof key !== 'string') continue;
    if (key.startsWith('update-card-focus')) hasCards = true;
    if (!key.startsWith('translatable-commentary-')) continue;
    const urn = commentaryUrn(key);
    commentaryKeys.add(urn ?? key);
    const commentary = props.textProps ?? props.initialContent;
    if (!urn || commentary === undefined) continue;
    const publishedAt = publishedFromUrn(urn, now);
    if (!publishedAt) continue;
    const text = renderText(commentary, records).trim();
    const parsed = postSchema.safeParse({
      id: urn,
      text,
      author: 'LinkedIn author',
      url: `https://www.linkedin.com/feed/update/${urn}/`,
      publishedAt,
      firstSeenAt: now.toISOString(),
    });
    if (!parsed.success) continue;
    // Prefer the most complete rendering of this exact commentary ID.
    if (text.length > (posts.get(urn)?.text.length ?? 0))
      posts.set(urn, parsed.data);
  }
  if (
    !commentaryKeys.size &&
    !hasCards &&
    !explicitEnd &&
    !/"(?:elements|items)":\s*\[\s*\]/.test(input)
  ) {
    throw new LinkedInError('response_format', 60, 'stream_no_cards');
  }
  if (commentaryKeys.size > posts.size || (hasCards && !posts.size)) {
    log('collector', 'stream_commentary_skipped', {
      commentaryCount: commentaryKeys.size,
      decodedPosts: posts.size,
    });
  }
  return [...posts.values()];
}
