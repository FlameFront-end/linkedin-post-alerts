import {
  postSchema,
  type Post,
} from '../../../../packages/contracts/src/index.js';
import { LinkedInError } from './errors.js';
import { continuation } from './pagination.js';
import { readJson, renderText, streamRecords } from './stream.js';
export const feedPagerId = 'com.linkedin.sdui.pagers.feed.mainFeed';
export const feedPaginationPath =
  '/flagship-web/rsc-action/actions/pagination?sduiid=' + feedPagerId;
export const feedContinuation = (input: string, html: boolean, after = -1) =>
  continuation(input, html, 'feed', after);

export function decodeFeedPage(input: string, now = new Date()): Post[] {
  const posts = new Map<string, Post>();
  const records = streamRecords(input);
  const markers = [
    ...input.matchAll(
      /"componentKey":"translatable-commentary-[^"]*?(shareId|ugcPostId)=(\d{10,25})[^"]*"/g,
    ),
  ];
  if (
    !markers.length &&
    !/"(?:elements|items|children)":\[\]|"(?:hasMore|hasNextPage)":false/.test(
      input,
    )
  )
    throw new LinkedInError('response_format', 60, 'stream_no_cards');
  for (const [index, marker] of markers.entries()) {
    const end = markers[index + 1]?.index ?? input.length;
    const start = input.indexOf(
      '"textProps":',
      marker.index + marker[0].length,
    );
    if (start < 0 || start >= end) continue;
    const props = readJson(input, start + '"textProps":'.length);
    const text = renderText(props, records).trim();
    const urn = `urn:li:${marker[1] === 'shareId' ? 'share' : 'ugcPost'}:${marker[2]}`;
    const published = Number(BigInt(marker[2]!) >> 22n);
    if (published < Date.UTC(2010, 0, 1) || published > now.getTime() + 60000)
      continue;
    const parsed = postSchema.safeParse({
      id: urn,
      text,
      author: 'LinkedIn author',
      url: `https://www.linkedin.com/feed/update/${urn}/`,
      publishedAt: new Date(published).toISOString(),
      firstSeenAt: now.toISOString(),
    });
    if (parsed.success && !posts.has(urn)) posts.set(urn, parsed.data);
  }
  if (markers.length && !posts.size)
    throw new LinkedInError('response_format', 60, 'stream_unreadable_cards');
  return [...posts.values()];
}
