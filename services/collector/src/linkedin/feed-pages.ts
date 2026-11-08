import {
  postSchema,
  type Post,
} from '../../../../packages/contracts/src/index.js';
import { vacancyImageUrl } from '../../../../packages/contracts/src/media.js';
import { commentaryUrn, publishedFromUrn } from './post-identity.js';
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
  const cards = [...input.matchAll(/"componentKey":"update-card-focus[^"]*"/g)];
  const groups = new Map<number, string>();
  const imageUrls = (fragment: string) =>
    [
      ...new Set(
        [...fragment.matchAll(/"(https:\/\/media\.licdn\.com[^"]*)"/g)].flatMap(
          (match) => {
            try {
              const value: unknown = JSON.parse('"' + match[1] + '"');
              return typeof value === 'string' && vacancyImageUrl(value)
                ? [value]
                : [];
            } catch {
              return [];
            }
          },
        ),
      ),
    ].slice(0, 2);
  const records = streamRecords(input);
  const markers = [
    ...input.matchAll(/"componentKey":"(translatable-commentary-[^"]*)"/g),
  ];
  if (
    !markers.length &&
    !cards.length &&
    !/"(?:elements|items|children)":\[\]|"(?:hasMore|hasNextPage)":false/.test(
      input,
    )
  )
    throw new LinkedInError('response_format', 60, 'stream_no_cards');
  for (const [index, marker] of markers.entries()) {
    const parent = cards
      .filter((card) => card.index < marker.index)
      .at(-1)?.index;
    const nextCard =
      cards.find((card) => card.index > marker.index)?.index ?? input.length;
    const end = Math.min(markers[index + 1]?.index ?? input.length, nextCard);
    const start = input.indexOf(
      '"textProps":',
      marker.index + marker[0].length,
    );
    if (start < 0 || start >= end) continue;
    const props = readJson(input, start + '"textProps":'.length);
    const text = renderText(props, records).trim();
    const urn = commentaryUrn(marker[1]!);
    if (!urn) continue;
    const published = publishedFromUrn(urn, now);
    if (!published) continue;
    const parsed = postSchema.safeParse({
      id: urn,
      text,
      imageUrls: imageUrls(input.slice(marker.index, end)),
      author: 'LinkedIn author',
      url: `https://www.linkedin.com/feed/update/${urn}/`,
      publishedAt: published,
      firstSeenAt: now.toISOString(),
    });
    if (parsed.success && !posts.has(urn)) {
      const group = parent === undefined ? undefined : groups.get(parent);
      const previous = group ? posts.get(group) : undefined;
      if (previous)
        posts.set(group!, {
          ...previous,
          text: [previous.text, parsed.data.text].join('\n\n').slice(0, 100000),
          imageUrls: [
            ...new Set([
              ...(previous.imageUrls ?? []),
              ...(parsed.data.imageUrls ?? []),
            ]),
          ].slice(0, 2),
        });
      else {
        posts.set(urn, parsed.data);
        if (parent !== undefined) groups.set(parent, urn);
      }
    }
  }
  for (const [index, card] of cards.entries()) {
    if (groups.has(card.index)) continue;
    const fragment = input.slice(
      card.index,
      cards[index + 1]?.index ?? input.length,
    );
    const urls = imageUrls(fragment);
    const urn = fragment.match(
      /urn:li:(?:activity|share|ugcPost):\d{10,25}/,
    )?.[0];
    const published = urn ? publishedFromUrn(urn, now) : undefined;
    if (urn && published && urls.length)
      posts.set(urn, {
        id: urn,
        text: '[Текст вакансии на изображении]',
        imageUrls: urls,
        author: 'LinkedIn author',
        url: `https://www.linkedin.com/feed/update/${urn}/`,
        publishedAt: published,
        firstSeenAt: now.toISOString(),
      });
  }
  if (markers.length && !posts.size)
    throw new LinkedInError('response_format', 60, 'stream_unreadable_cards');
  return [...posts.values()];
}
