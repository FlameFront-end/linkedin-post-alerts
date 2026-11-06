import {
  postSchema,
  type Post,
} from '../../../../packages/contracts/src/index.js';

export const feedPagerId = 'com.linkedin.sdui.pagers.feed.mainFeed';
export const feedPaginationPath =
  '/flagship-web/rsc-action/actions/pagination?sduiid=' + feedPagerId;

function readObject(
  input: string,
  start: number,
): Record<string, unknown> | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(input.slice(start, i + 1));
      } catch {
        return;
      }
    }
  }
}

export function feedContinuation(input: string, html: boolean, after = -1) {
  const text = html
    ? input.replaceAll(String.fromCharCode(92) + '"', '"')
    : input;
  const marker =
    '{"$type":"proto.sdui.actions.requests.PaginationRequest","pagerId":"' +
    feedPagerId +
    '"';
  let best: { body: string; start: number } | undefined;
  for (
    let at = text.indexOf(marker);
    at >= 0;
    at = text.indexOf(marker, at + marker.length)
  ) {
    const request = readObject(text, at);
    const args = request?.requestedArguments as
      { payload?: Record<string, unknown> } | undefined;
    const payload = args?.payload;
    const start = payload?.startIndex;
    if (
      !request ||
      !args ||
      payload?.requestType !== 'Pagination' ||
      payload.feedSortOrder !== 'FeedSortOrder_RELEVANCE' ||
      typeof payload.token !== 'string' ||
      !payload.token ||
      typeof start !== 'number' ||
      !Number.isSafeInteger(start) ||
      start <= after ||
      (best && start >= best.start)
    )
      continue;
    best = {
      start,
      body: JSON.stringify({
        pagerId: feedPagerId,
        clientArguments: {
          ...args,
          states: [],
          screenId: 'com.linkedin.sdui.flagshipnav.feed.ForYouFeed',
          knownTemplateIds: [],
        },
        paginationRequest: request,
      }),
    };
  }
  return best;
}

function render(value: unknown): string {
  if (typeof value === 'string') return value.startsWith('$') ? '' : value;
  if (!Array.isArray(value)) return '';
  if (value[0] === '$')
    return value[1] === 'br' ? '\n' : render(value[3]?.children);
  return value.map(render).join('');
}

export function decodeFeedPage(input: string, now = new Date()): Post[] {
  const posts = new Map<string, Post>();
  const markers = [
    ...input.matchAll(
      /"componentKey":"translatable-commentary-[^"]*?(shareId|ugcPostId)=(\d{10,25})[^"]*"/g,
    ),
  ];
  for (const [index, marker] of markers.entries()) {
    const end = markers[index + 1]?.index ?? input.length;
    const start = input.indexOf(
      '"textProps":{',
      marker.index + marker[0].length,
    );
    if (start < 0 || start >= end) continue;
    const props = readObject(input, start + '"textProps":'.length);
    const text = render(props?.children).trim();
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
  return [...posts.values()];
}
