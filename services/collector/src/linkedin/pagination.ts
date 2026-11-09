import { load } from 'cheerio';
import { readJson, streamText } from './stream.js';
export interface Continuation {
  pagerId: string;
  body: string;
  start: number;
}
export const validPager = (id: string) =>
  /^com\.linkedin\.sdui\.pagers\.(?:feed|search)\.[A-Za-z0-9_.-]+$/.test(id);

/** Only replay pagination arguments actually supplied by the server. */
export function continuation(
  input: string,
  html: boolean,
  surface: 'feed' | 'search',
  after = -1,
): Continuation | undefined {
  const text = streamText(input, html);
  let best: Continuation | undefined;
  for (const match of text.matchAll(
    /\{"\$type":"proto\.sdui\.actions\.requests\.PaginationRequest"/g,
  )) {
    const request = readJson(text, match.index) as
      Record<string, unknown> | undefined;
    const args = request?.requestedArguments as
      { payload?: Record<string, unknown>; screenId?: string } | undefined;
    const payload = args?.payload;
    const start = payload?.startIndex ?? payload?.start;
    const id = request?.pagerId;
    if (
      !request ||
      !args ||
      typeof id !== 'string' ||
      !validPager(id) ||
      !id.includes(`.${surface}.`) ||
      typeof start !== 'number' ||
      !Number.isSafeInteger(start) ||
      start <= after ||
      (best && start >= best.start)
    )
      continue;
    if (
      surface === 'feed' &&
      (payload?.requestType !== 'Pagination' ||
        typeof payload.token !== 'string' ||
        !payload.token)
    )
      continue;
    best = {
      start,
      pagerId: id,
      body: JSON.stringify({
        pagerId: id,
        clientArguments: {
          ...args,
          states: [],
          ...(surface === 'feed'
            ? { screenId: 'com.linkedin.sdui.flagshipnav.feed.ForYouFeed' }
            : {}),
          knownTemplateIds: [],
        },
        paginationRequest: request,
      }),
    };
  }
  return best;
}
const nextSelector =
  'a[rel="next"], a[aria-label="Next"], a[aria-label="Далее"], button[aria-label="Next"], button[aria-label="Далее"]';
export function nextSearchLink(html: string): string | undefined {
  const $ = load(html);
  for (const node of $(nextSelector).toArray()) {
    if ($(node).attr('aria-disabled') === 'true' || $(node).is('[disabled]'))
      continue;
    const href = $(node).attr('href');
    if (!href) continue;
    try {
      const url = new URL(href, 'https://www.linkedin.com');
      if (
        url.origin === 'https://www.linkedin.com' &&
        url.pathname === '/search/results/content/' &&
        !url.username &&
        !url.password &&
        !url.hash
      )
        return url.pathname + url.search;
    } catch {
      /* Ignore invalid links, checking the remaining next controls. */
    }
  }
}
export type SearchPaginationState = 'continuation' | 'end' | 'unknown';
/** Absence of a next control alone never proves either end-of-results or lost results. */
export function searchPaginationState(
  html: string,
  hasContinuation: boolean,
): SearchPaginationState {
  if (hasContinuation) return 'continuation';
  const $ = load(html);
  const controls = $(nextSelector).toArray();
  if (
    controls.length &&
    controls.every(
      (node) =>
        $(node).attr('aria-disabled') === 'true' || $(node).is('[disabled]'),
    )
  )
    return 'end';
  return 'unknown';
}
